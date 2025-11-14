import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import axios, { AxiosResponse } from 'axios';
import { SingleBar } from 'cli-progress';
import Table from 'cli-table3';
import Logger from '../logger/logger';
import fs from 'fs';
import path from 'path';
import Batcher from '../runtime/batcher';

class txStats {
    txHash: string;
    block = 0;

    constructor(txHash: string, block: number) {
        this.txHash = txHash;
        this.block = block;
    }
}

class BlockInfo {
    blockNum: number;
    createdAt: number;
    numTxs: number;

    gasUsed: string;
    gasLimit: string;
    gasUtilization: number;

    constructor(
        blockNum: number,
        createdAt: number,
        numTxs: number,
        gasUsed: BigNumber,
        gasLimit: BigNumber
    ) {
        this.blockNum = blockNum;
        this.createdAt = createdAt;
        this.numTxs = numTxs;
        this.gasUsed = gasUsed.toHexString();
        this.gasLimit = gasLimit.toHexString();

        const largeDivision = gasUsed
            .mul(BigNumber.from(10000))
            .div(gasLimit)
            .toNumber();

        this.gasUtilization = largeDivision / 100;
    }
}

class CollectorData {
    tps: number;
    blockInfo: Map<number, BlockInfo>;

    constructor(tps: number, blockInfo: Map<number, BlockInfo>) {
        this.tps = tps;
        this.blockInfo = blockInfo;
    }
}

class txBatchResult {
    succeeded: txStats[];
    remaining: string[];

    errors: string[];

    constructor(succeeded: txStats[], remaining: string[], errors: string[]) {
        this.succeeded = succeeded;
        this.remaining = remaining;

        this.errors = errors;
    }
}

class StatCollector {
    // Store last used cacheFile and cachedReceipts for event-based dumping
    private _lastCacheFile: string | undefined;
    private _lastCachedReceipts: Record<string, any> | undefined;

    // Call this to dump the latest receipts to disk (for SIGTERM/SIGINT)
    dumpCache(): void {
        if (this._lastCacheFile && this._lastCachedReceipts) {
            try {
                // console.log("this._lastCachedReceipts ====>>>>> ", this._lastCachedReceipts)
                fs.writeFileSync(path.resolve(this._lastCacheFile), JSON.stringify(this._lastCachedReceipts, null, 2), 'utf8');
                Logger.info(`Cache dumped to ${this._lastCacheFile} on signal.`);
            } catch (e) {
                Logger.warn(`Failed to dump cache file ${this._lastCacheFile}: ${e}`);
            }
        }
    }
    async gatherTransactionReceipts(
        txHashes: string[],
        batchSize: number,
        provider: Provider,
        cacheFile: string = 'temp.json'
    ): Promise<txStats[]> {
        Logger.info('Gathering transaction receipts...');

        const receiptBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        receiptBar.start(txHashes.length, 0, {
            speed: 'N/A',
        });

        // Load cached receipts if available
    let cachedReceipts: Record<string, any> = {};
    const cachePath = path.resolve(cacheFile);
    // Track for event-based dumping
    this._lastCacheFile = cacheFile;
    this._lastCachedReceipts = cachedReceipts;
        if (fs.existsSync(cachePath)) {
            try {
                cachedReceipts = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            } catch (e) {
                Logger.warn(`Could not parse ${cacheFile}, starting with empty cache.`);
            }
            // Update tracked receipts for event-based dumping
            this._lastCachedReceipts = cachedReceipts;
        }

        const fetchErrors: string[] = [];
        let receiptBarProgress = 0;
        let retryCounter = Math.ceil(txHashes.length * 0.025);
        let remainingTransactions: string[] = [];
        let succeededTransactions: txStats[] = [];

        // Partition txHashes into cached and uncached
        for (const txHash of txHashes) {
            if (cachedReceipts[txHash]) {
                const receipt = cachedReceipts[txHash];
                succeededTransactions.push(new txStats(txHash, receipt.blockNumber));
                receiptBar.increment(1);
            } else {
                remainingTransactions.push(txHash);
            }
        }

        const providerURL = (provider as JsonRpcProvider).connection.url;

        // Fetch transaction receipts in batches for uncached txs
        while (remainingTransactions.length > 0) {
            const result = await this.fetchTransactionReceipts(
                remainingTransactions,
                batchSize,
                providerURL,
                cachedReceipts,
                cacheFile
            );
            for (const fetchErr of result.errors) {
                fetchErrors.push(fetchErr);
            }
            // Update the remaining transactions whose receipts need to be fetched
            remainingTransactions = result.remaining;
            // Save the succeeded transactions and cache them
            for (const stat of result.succeeded) {
                succeededTransactions.push(stat);
                cachedReceipts[stat.txHash] = { blockNumber: stat.block };
            }
            // Update the user loading bar
            receiptBar.increment(result.succeeded.length);
            receiptBarProgress += result.succeeded.length;
            retryCounter--;
            if (remainingTransactions.length == 0 || retryCounter == 0) {
                break;
            }
            await new Promise((resolve) => {
                provider.once('block', () => {
                    resolve(null);
                });
            });
        }

        // Wait for the transaction receipts individually if not retrieved in batch
        for (const txHash of remainingTransactions) {
            let txReceipt;
            try {
                txReceipt = await provider.waitForTransaction(
                    txHash,
                    1,
                    30 * 1000 // 30s per transaction
                );
                receiptBar.increment(1);
                if (txReceipt.status != undefined && txReceipt.status == 0) {
                    throw new Error(
                        `transaction ${txReceipt.transactionHash} failed on execution`
                    );
                }
                succeededTransactions.push(new txStats(txHash, txReceipt.blockNumber));
                cachedReceipts[txHash] = { blockNumber: txReceipt.blockNumber };
            } catch (e) {
                Logger.error(`Error waiting for transaction receipt for ${txHash}: ${e}`);
            }
            // Always write cache after each receipt attempt
            try {
                fs.writeFileSync(cachePath, JSON.stringify(cachedReceipts, null, 2), 'utf8');
            } catch (e) {
                Logger.warn(`Failed to write cache file ${cacheFile}: ${e}`);
            }
        }

        // Write updated cache
        try {
            fs.writeFileSync(cachePath, JSON.stringify(cachedReceipts, null, 2), 'utf8');
        } catch (e) {
            Logger.warn(`Failed to write cache file ${cacheFile}: ${e}`);
        }

        receiptBar.stop();
        if (fetchErrors.length > 0) {
            Logger.warn('Errors encountered during batch sending:');
            for (const err of fetchErrors) {
                Logger.error(err);
            }
        }
        Logger.success('Gathered transaction receipts');
        return succeededTransactions;
    }

    async fetchTransactionReceipts(
        txHashes: string[],
        batchSize: number,
        url: string,
        cachedReceipts?: Record<string, any>,
        cacheFile?: string
    ): Promise<txBatchResult> {
        // Create the batches for transaction receipts
        const batches: string[][] = Batcher.generateBatches<string>(
            txHashes,
            batchSize
        );
        const succeeded: txStats[] = [];
        const remaining: string[] = [];
        const batchErrors: string[] = [];

        let nextIndx = 0;
        const MAX_CONCURRENT = 200;
        const AXIOS_TIMEOUT_MS = 30000;
    // Track for event-based dumping
    this._lastCacheFile = cacheFile;
    this._lastCachedReceipts = cachedReceipts;
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
            const batchGroup = batches.slice(i, i + MAX_CONCURRENT);
            // Prepare requests for this group
            const requests = batchGroup.map((hashes) => {
                let singleRequests = '';
                for (let j = 0; j < hashes.length; j++) {
                    singleRequests += JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'eth_getTransactionReceipt',
                        params: [hashes[j]],
                        id: nextIndx++,
                    });
                    if (j != hashes.length - 1) {
                        singleRequests += ',\n';
                    }
                }
                return axios({
                    url: url,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    data: '[' + singleRequests + ']',
                    timeout: AXIOS_TIMEOUT_MS,
                });
            });
            // Await all requests in this group, with error handling and timeout
            let responses: AxiosResponse<any>[] = [];
            for (let reqIdx = 0; reqIdx < requests.length; reqIdx++) {
                try {
                    const resp = await requests[reqIdx];
                    Logger.info(`Batch request succeeded [batchGroupIdx=${i}, requestIdx=${reqIdx}]`);
                    for (let k = 0; k < resp.data.length; k++) {
                        const item = resp.data[k];
                        const txHash = batchGroup[reqIdx][k];
                        if (item?.result) {
                            Logger.info(`  txHash=${txHash}, blockHash=${item.result.blockHash}`);
                        } else {
                            Logger.info(`  txHash=${txHash}, receipt not found (result=null)`);
                        }
                    }
                    responses.push(resp);
                } catch (err: any) {
                    // Timeout or other error handling
                    if (err?.code === 'ECONNABORTED' || err?.message?.includes('timeout')) {
                        Logger.error(`Batch request timed out [batchGroupIdx=${i}, requestIdx=${reqIdx}]`);
                    } else {
                        Logger.error(`Batch request failed [batchGroupIdx=${i}, requestIdx=${reqIdx}]`);
                    }
                    Logger.error(`TxHashes: ${JSON.stringify(batchGroup[reqIdx])}`);
                    Logger.error(`Error: ${err?.message || err}`);
                    if (err?.code) Logger.error(`Error code: ${err.code}`);
                    if (err?.stack) Logger.error(`Stack: ${err.stack}`);
                    if (err?.response?.status) Logger.error(`HTTP status: ${err.response.status}`);
                    batchErrors.push(`BatchGroupIdx=${i}, RequestIdx=${reqIdx}: ${err?.message || err}`);
                    // Mark all txHashes in this failed batch as remaining
                    for (const txHash of batchGroup[reqIdx]) {
                        remaining.push(txHash);
                    }
                }
            }

            let newReceipts: Record<string, any> = {};
            for (let batchIndex = 0; batchIndex < responses.length; batchIndex++) {
                const data = responses[batchIndex].data;
                for (let txHashIndex = 0; txHashIndex < data.length; txHashIndex++) {
                    const batchItem = data[txHashIndex];
                    const txHash = batchGroup[batchIndex][txHashIndex];
                    if (batchItem.result) {
                        if (cachedReceipts) {
                            cachedReceipts[txHash] = { blockNumber: batchItem.result.blockNumber };
                            newReceipts[txHash] = { blockNumber: batchItem.result.blockNumber };
                        }
                    }
                    if (!batchItem.result) {
                        remaining.push(batchGroup[batchIndex][txHashIndex]);
                        continue;
                    }
                    // eslint-disable-next-line no-prototype-builtins
                    if (batchItem.hasOwnProperty('error')) {
                        batchErrors.push(batchItem.error.message);
                        continue;
                    }
                    if (batchItem.result.status == '0x0') {
                        throw new Error(
                            `transaction ${batchItem.result.transactionHash} failed on execution`
                        );
                    }
                    succeeded.push(
                        new txStats(
                            batchItem.result.transactionHash,
                            batchItem.result.blockNumber
                        )
                    );
                }
            }
            // Write updated cache after each batch group, regardless of success
            if (cacheFile && cachedReceipts) {
                try {
                    fs.writeFileSync(path.resolve(cacheFile), JSON.stringify(cachedReceipts, null, 2), 'utf8');
                } catch (e) {
                    Logger.warn(`Failed to write cache file ${cacheFile}: ${e}`);
                }
                // Update tracked receipts for event-based dumping
                this._lastCachedReceipts = cachedReceipts;
            }
        }
        return new txBatchResult(succeeded, remaining, batchErrors);
    }

    async fetchBlockInfo(
        stats: txStats[],
        provider: Provider
    ): Promise<Map<number, BlockInfo>> {
        const blockSet: Set<number> = new Set<number>();
        for (const s of stats) {
            blockSet.add(s.block);
        }

        const blockFetchErrors: Error[] = [];

        Logger.info('\nGathering block info...');
        const blocksBar = new SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
        });

        blocksBar.start(blockSet.size, 0, {
            speed: 'N/A',
        });

        const blocksMap: Map<number, BlockInfo> = new Map<number, BlockInfo>();
        for (const block of blockSet.keys()) {
            try {
                const fetchedInfo = await provider.getBlock(block);

                blocksBar.increment();

                blocksMap.set(
                    block,
                    new BlockInfo(
                        block,
                        fetchedInfo.timestamp,
                        fetchedInfo.transactions.length,
                        fetchedInfo.gasUsed,
                        fetchedInfo.gasLimit
                    )
                );
            } catch (e: any) {
                blockFetchErrors.push(e);
            }
        }

        blocksBar.stop();

        Logger.success('Gathered block info');

        if (blockFetchErrors.length > 0) {
            Logger.warn('Errors encountered during block info fetch:');

            for (const err of blockFetchErrors) {
                Logger.error(err.message);
            }
        }

        return blocksMap;
    }

    async calcTPS(stats: txStats[], provider: Provider): Promise<number> {
        Logger.title('\n🧮 Calculating TPS data 🧮\n');
        let totalTxs = 0;
        let totalTime = 0;

        // Find the average txn time per block
        const blockFetchErrors = [];
        const blockTimeMap: Map<number, number> = new Map<number, number>();
        const uniqueBlocks = new Set<number>();

        for (const stat of stats) {
            if (stat.block == 0) {
                continue;
            }

            totalTxs++;
            uniqueBlocks.add(stat.block);
        }

        for (const block of uniqueBlocks) {
            // Get the parent block to find the generation time
            try {
                const currentBlockNum = block;
                const parentBlockNum = currentBlockNum - 1;

                if (!blockTimeMap.has(parentBlockNum)) {
                    const parentBlock = await provider.getBlock(parentBlockNum);

                    blockTimeMap.set(parentBlockNum, parentBlock.timestamp);
                }

                const parentBlock = blockTimeMap.get(parentBlockNum) as number;

                if (!blockTimeMap.has(currentBlockNum)) {
                    const currentBlock =
                        await provider.getBlock(currentBlockNum);

                    blockTimeMap.set(currentBlockNum, currentBlock.timestamp);
                }

                const currentBlock = blockTimeMap.get(
                    currentBlockNum
                ) as number;

                totalTime += Math.round(Math.abs(currentBlock - parentBlock));
            } catch (e: any) {
                blockFetchErrors.push(e);
            }
        }

        return Math.ceil(totalTxs / totalTime);
    }

    printBlockData(blockInfoMap: Map<number, BlockInfo>) {
        Logger.info('\nBlock utilization data:');
        const utilizationTable = new Table({
            head: [
                'Block #',
                'Gas Used [wei]',
                'Gas Limit [wei]',
                'Transactions',
                'Utilization',
            ],
        });

        const sortedMap = new Map(
            [...blockInfoMap.entries()].sort((a, b) => a[0] - b[0])
        );

        sortedMap.forEach((info) => {
            utilizationTable.push([
                info.blockNum,
                info.gasUsed,
                info.gasLimit,
                info.numTxs,
                `${info.gasUtilization}%`,
            ]);
        });

        Logger.info(utilizationTable.toString());
    }

    printFinalData(tps: number, blockInfoMap: Map<number, BlockInfo>) {
        // Find average utilization
        let totalUtilization = 0;
        blockInfoMap.forEach((info) => {
            totalUtilization += info.gasUtilization;
        });
        const avgUtilization = totalUtilization / blockInfoMap.size;

        const finalDataTable = new Table({
            head: ['TPS', 'Blocks', 'Avg. Utilization'],
        });

        finalDataTable.push([
            tps,
            blockInfoMap.size,
            `${avgUtilization.toFixed(2)}%`,
        ]);

        Logger.info(finalDataTable.toString());
    }

    async generateStats(
        txHashes: string[],
        mnemonic: string,
        url: string,
        batchSize: number
    ): Promise<CollectorData> {
        if (txHashes.length == 0) {
            Logger.warn('No stat data to display');

            return new CollectorData(0, new Map());
        }

        Logger.title('\n⏱ Statistics calculation initialized ⏱\n');

        const provider = new JsonRpcProvider(url);

        // Fetch receipts
        const txStats = await this.gatherTransactionReceipts(
            txHashes,
            batchSize,
            provider
        );

        // Fetch block info
        const blockInfoMap = await this.fetchBlockInfo(txStats, provider);

        // Print the block utilization data
        this.printBlockData(blockInfoMap);

        // Print the final TPS and avg. utilization data
        const avgTPS = await this.calcTPS(txStats, provider);
        this.printFinalData(avgTPS, blockInfoMap);

        return new CollectorData(avgTPS, blockInfoMap);
    }
}

export { StatCollector, CollectorData, BlockInfo };