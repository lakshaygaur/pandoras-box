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

    async distribute(): Promise<number[]> {
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

        // Fund the accounts
        await this.fundAccounts(baseCosts, fundableAccounts);

        Logger.success('Fund distribution finished!');

        return this.readyMnemonicIndexes;
    }

    async calculateRuntimeCosts(): Promise<runtimeCosts> {
        console.log("starting calculations")
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

        console.log("finished calculations")
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

        // Fetch all balances in parallel, incrementing the bar as each completes, with timeout and logging
        const balancePromises = wallets.map(({ index, wallet }) =>
            this.withTimeout(wallet.getBalance(), 10000, `getBalance for index ${index}`)
                .then(balance => {
                    balanceBar.increment();
                    Logger.info(`Fetched balance for index ${index}: ${balance.toString()}`);
                    return { index, wallet, balance };
                })
                .catch(err => {
                    Logger.error(`Failed to fetch balance for index ${index}: ${err instanceof Error ? err.message : String(err)}`);
                    return { index, wallet, balance: BigNumber.from(0) };
                })
        );

        const results = await Promise.all(balancePromises);

        // Check if all balances failed (all are zero)
        const allFailed = results.every(({ balance }) => balance.eq(0));
        if (allFailed) {
            Logger.error('FATAL: All balance requests failed. Exiting.');
            process.exit(1);
        }

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

    async fundAccounts(costs: runtimeCosts, accounts: distributeAccount[]) {
        Logger.info('\nFunding accounts...');

        const fundBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        fundBar.start(accounts.length, 0, {
            speed: 'N/A',
        });

        // Helper for retrying a transaction
        const sendWithRetry = async (acc: distributeAccount, retries = 3) => {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    Logger.info(`Funding account ${acc.address} (index ${acc.mnemonicIndex}), attempt ${attempt}`);
                    await this.withTimeout(
                        this.ethWallet.sendTransaction({
                            to: acc.address,
                            value: acc.missingFunds,
                        }),
                        15000,
                        `sendTransaction for index ${acc.mnemonicIndex}`
                    );
                    this.readyMnemonicIndexes.push(acc.mnemonicIndex);
                    // Logger.info(`Successfully funded account ${acc.address} (index ${acc.mnemonicIndex})`);
                    return true;
                } catch (err) {
                    const errorMsg = (err instanceof Error) ? err.message : String(err);
                    // Logger.error(`Funding error for account ${acc.address} (index ${acc.mnemonicIndex}), attempt ${attempt}: ${errorMsg}`);
                    if (attempt < retries) {
                        // Logger.warn(`Retrying funding for account ${acc.address} (index ${acc.mnemonicIndex}), attempt ${attempt}`);
                        await new Promise(res => setTimeout(res, 1000 * attempt)); // Exponential backoff
                    } else {
                        // Logger.error(`Funding failed for account ${acc.address} after ${retries} attempts: ${errorMsg}`);
                        return false;
                    }
                }
            }
        };

        // Send transactions in batches of 1000
        const BATCH_SIZE = 1000;
        for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
            const batch = accounts.slice(i, i + BATCH_SIZE);
            const txPromises = batch.map(async acc => {
                await sendWithRetry(acc);
                fundBar.increment();
            });
            await Promise.all(txPromises);
        }

        fundBar.stop();
    }
}

export { Distributor, Runtime, distributeAccount };
