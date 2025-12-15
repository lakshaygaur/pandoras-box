import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { formatEther } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Heap from 'heap';
import Logger from '../logger/logger';
import { Runtime } from '../runtime/runtimes';
import DistributorErrors from './errors';

class distributeAccount {
    missingFunds: BigNumber;
    address: string;
    mnemonicIndex: number;

    constructor(missingFunds: BigNumber, address: string, index: number) {
        this.missingFunds = missingFunds;
        this.address = address;
        this.mnemonicIndex = index;
    }
}

class runtimeCosts {
    accDistributionCost: BigNumber;
    subAccount: BigNumber;

    constructor(accDistributionCost: BigNumber, subAccount: BigNumber) {
        this.accDistributionCost = accDistributionCost;
        this.subAccount = subAccount;
    }
}

// Manages the fund distribution before each run-cycle
class Distributor {
    ethWallet: Wallet;
    mnemonic: string;
    provider: Provider;

    runtimeEstimator: Runtime;

    totalTx: number;
    requestedSubAccounts: number;
    readyMnemonicIndexes: number[];

    constructor(
        mnemonic: string,
        subAccounts: number,
        totalTx: number,
        runtimeEstimator: Runtime,
        url: string
    ) {
        this.requestedSubAccounts = subAccounts;
        this.totalTx = totalTx;
        this.mnemonic = mnemonic;
        this.runtimeEstimator = runtimeEstimator;
        this.readyMnemonicIndexes = [];

        this.provider = new JsonRpcProvider(url);
        this.ethWallet = Wallet.fromMnemonic(
            mnemonic,
            `m/44'/60'/0'/0/0`
        ).connect(this.provider);
    }

    async distribute(fundingWallets?: Wallet[]): Promise<number[]> {
        Logger.title('💸 Fund distribution initialized 💸');

        const baseCosts = await this.calculateRuntimeCosts();
        this.printCostTable(baseCosts);

        // Check if there are any addresses that need funding
        const shortAddresses = await this.findAccountsForDistribution(
            baseCosts.subAccount
        );

        const initialAccCount = shortAddresses.size();

        if (initialAccCount == 0) {
            // Nothing to distribute
            Logger.success('Accounts are fully funded for the cycle');

            return this.readyMnemonicIndexes;
        }

        // Get a list of accounts that can be funded
        const fundableAccounts = await this.getFundableAccounts(
            baseCosts,
            shortAddresses
        );

        if (fundableAccounts.length != initialAccCount) {
            Logger.warn(
                `Unable to fund all sub-accounts. Funding ${fundableAccounts.length}`
            );
        }

        // Fund the accounts with optional funding wallets for parallelization
        await this.fundAccounts(baseCosts, fundableAccounts, fundingWallets);

        Logger.success('Fund distribution finished!');

        return this.readyMnemonicIndexes;
    }

    async calculateRuntimeCosts(): Promise<runtimeCosts> {
        const inherentValue = this.runtimeEstimator.GetValue();
        const baseTxEstimate = await this.runtimeEstimator.EstimateBaseTx();
        const baseGasPrice = await this.runtimeEstimator.GetGasPrice();

        const baseTxCost = baseGasPrice.mul(baseTxEstimate).add(inherentValue);

        // Calculate how much each sub-account needs
        // to execute their part of the run cycle.
        // Each account needs at least numTx * (gasPrice * gasLimit + value)
        const subAccountCost = BigNumber.from(this.totalTx).mul(baseTxCost);

        // Calculate the cost of the single distribution transaction
        const singleDistributionCost = await this.provider.estimateGas({
            from: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/0`)
                .address,
            to: Wallet.fromMnemonic(this.mnemonic, `m/44'/60'/0'/0/1`).address,
            value: subAccountCost,
        });

        return new runtimeCosts(singleDistributionCost, subAccountCost);
    }

    // Helper for timeout
    private withTimeout<T>(promise: Promise<T>, ms: number, context: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                Logger.error(`Timeout after ${ms}ms in ${context}`);
                reject(new Error(`Timeout after ${ms}ms in ${context}`));
            }, ms);
            promise.then(
                val => { clearTimeout(timer); resolve(val); },
                err => { clearTimeout(timer); reject(err); }
            );
        });
    }

    async findAccountsForDistribution(
        singleRunCost: BigNumber
    ): Promise<Heap<distributeAccount>> {
        const balanceBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        Logger.info('\nFetching sub-account balances...');

        const shortAddresses = new Heap<distributeAccount>();

        Logger.info(`Starting progress bar for ${this.requestedSubAccounts} sub-accounts`);
        balanceBar.start(this.requestedSubAccounts, 0, {
            speed: 'N/A',
        });

        // Prepare all wallets
        const wallets = [];
        for (let i = 1; i <= this.requestedSubAccounts; i++) {
            wallets.push({
                index: i,
                wallet: Wallet.fromMnemonic(
                    this.mnemonic,
                    `m/44'/60'/0'/0/${i}`
                ).connect(this.provider)
            });
        }

        // Helper for timeout
        function withTimeout<T>(promise: Promise<T>, ms: number, context: string): Promise<T> {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    Logger.error(`Timeout after ${ms}ms in ${context}`);
                    reject(new Error(`Timeout after ${ms}ms in ${context}`));
                }, ms);
                promise.then(
                    val => { clearTimeout(timer); resolve(val); },
                    err => { clearTimeout(timer); reject(err); }
                );
            });
        }

        // Fetch balances in batches of 2000
        const MAX_BATCH = 2000;
        let results: Array<{ index: number, wallet: Wallet, balance: BigNumber }> = [];
        for (let i = 0; i < wallets.length; i += MAX_BATCH) {
            const batch = wallets.slice(i, i + MAX_BATCH);
            const balancePromises = batch.map(({ index, wallet }) =>
                this.withTimeout(wallet.getBalance(), 10000, `getBalance for index ${index}`)
                    .then(balance => {
                        balanceBar.increment();
                        return { index, wallet, balance };
                    })
                    .catch(err => {
                        Logger.error(`Failed to fetch balance for index ${index}: ${err instanceof Error ? err.message : String(err)}`);
                        return { index, wallet, balance: BigNumber.from(0) };
                    })
            );
            const batchResults = await Promise.all(balancePromises);
            results = results.concat(batchResults);
        }

        // // Check if all balances failed (all are zero)
        // const allFailed = results.every(({ balance }) => balance.eq(0));
        // if (allFailed) {
        //     Logger.error('FATAL: All balance requests failed. Exiting.');
        //     process.exit(1);
        // }

        for (const { index, wallet, balance } of results) {
            if (balance.lt(singleRunCost)) {
                shortAddresses.push(
                    new distributeAccount(
                        singleRunCost.sub(balance),
                        wallet.address,
                        index
                    )
                );
            } else {
                this.readyMnemonicIndexes.push(index);
            }
        }

        balanceBar.stop();

        return shortAddresses;
    }

    printCostTable(costs: runtimeCosts) {
        Logger.info('\nCycle Cost Table:');
        const costTable = new Table({
            head: ['Name', 'Cost [eth]'],
        });

        costTable.push(
            ['Required acc. balance', formatEther(costs.subAccount)],
            ['Single distribution cost', formatEther(costs.accDistributionCost)]
        );

        Logger.info(costTable.toString());
    }

    async getFundableAccounts(
        costs: runtimeCosts,
        initialSet: Heap<distributeAccount>
    ): Promise<distributeAccount[]> {
        // Check if the root wallet has enough funds to distribute
        const accountsToFund: distributeAccount[] = [];
        let distributorBalance = BigNumber.from(
            await this.ethWallet.getBalance()
        );

        while (
            distributorBalance.gt(costs.accDistributionCost) &&
            initialSet.size() > 0
        ) {
            const acc = initialSet.pop() as distributeAccount;
            distributorBalance = distributorBalance.sub(acc.missingFunds);

            accountsToFund.push(acc);
        }

        // Check if there are accounts to fund
        if (accountsToFund.length == 0) {
            throw DistributorErrors.errNotEnoughFunds;
        }

        return accountsToFund;
    }

    async fundAccounts(costs: runtimeCosts, accounts: distributeAccount[], fundingWallets: Wallet[] = [this.ethWallet]) {
        Logger.info('\nFunding accounts...');

        const fundBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        fundBar.start(accounts.length, 0, {
            speed: 'N/A',
        });

        // Helper for retrying a transaction with extended timeout for large batches
        const sendWithRetry = async (acc: distributeAccount, wallet: Wallet, retries = 5) => {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    // Logger.info(`Funding account ${acc.address} (index ${acc.mnemonicIndex}), attempt ${attempt}`);
                    const tx = await this.withTimeout(
                        wallet.sendTransaction({
                            to: acc.address,
                            value: acc.missingFunds.mul(10),
                        }),
                        120000,
                        `sendTransaction for index ${acc.mnemonicIndex}`
                    );
                    // Wait for transaction to be mined before marking as ready
                    await this.withTimeout(
                        tx.wait(),
                        240000,
                        `wait for tx ${tx.hash} for index ${acc.mnemonicIndex}`
                    );
                    this.readyMnemonicIndexes.push(acc.mnemonicIndex);
                    return true;
                } catch (err) {
                    const errorMsg = (err instanceof Error) ? err.message : String(err);
                    Logger.warn(`Funding attempt ${attempt}/${retries} failed for index ${acc.mnemonicIndex}: ${errorMsg}`);
                    if (attempt < retries) {
                        // Exponential backoff with longer delays for RPC recovery
                        const backoffMs = Math.min(5000 * Math.pow(2, attempt - 1), 30000);
                        Logger.info(`Retrying in ${backoffMs}ms...`);
                        await new Promise(res => setTimeout(res, backoffMs));
                    } else {
                        Logger.error(`Failed to fund account ${acc.address} (index ${acc.mnemonicIndex}) after ${retries} attempts`);
                        return false;
                    }
                }
            }
        };

        // Run funding with concurrency control: distribute accounts across multiple wallets
        const accountsPerWallet = Math.ceil(accounts.length / fundingWallets.length);
        const fundingPromises = fundingWallets.map(async (wallet, walletIdx) => {
            const startIdx = walletIdx * accountsPerWallet;
            const endIdx = Math.min(startIdx + accountsPerWallet, accounts.length);
            const accountsToFund = accounts.slice(startIdx, endIdx);

            // Process sequentially per wallet to avoid nonce conflicts and RPC overload
            for (const acc of accountsToFund) {
                await sendWithRetry(acc, wallet);
                fundBar.increment();
            }
        });

        await Promise.all(fundingPromises);
        fundBar.stop();
    }
}

export { Distributor, Runtime, distributeAccount };
