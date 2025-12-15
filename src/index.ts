#!/usr/bin/env node
import { Command } from 'commander';
// ...existing imports...
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Distributor, Runtime } from './distributor/distributor';
import TokenDistributor from './distributor/tokenDistributor';
import Logger from './logger/logger';
import Outputter from './outputter/outputter';
import { Engine, EngineContext } from './runtime/engine';
import EOARuntime from './runtime/eoa';
import ERC20Runtime from './runtime/erc20';
import ERC721Runtime from './runtime/erc721';
import RuntimeErrors from './runtime/errors';
import {
    InitializedRuntime,
    RuntimeType,
    TokenRuntime,
} from './runtime/runtimes';
import { StatCollector } from './stats/collector';

async function run() {
    // Create StatCollector instance early so signal handlers can access it
    const statCollector = new StatCollector();

    // Add SIGTERM/SIGINT event handlers to dump cache before any awaits
    process.on('SIGTERM', () => {
        statCollector.dumpCache();
        Logger.warn('SIGTERM received, cache dumped. Exiting.');
        process.exit(0);
    });
    process.on('SIGINT', () => {
        statCollector.dumpCache();
        Logger.warn('SIGINT received, cache dumped. Exiting.');
        process.exit(0);
    });

    const program = new Command();

    program
        .name('pandoras-box')
        .description(
            'A small and simple stress testing tool for Ethereum-compatible blockchain clients '
        )
        .version('1.0.0');

    program
        .requiredOption(
            '-u, --json-rpc <json-rpc-address>',
            'The URL of the JSON-RPC for the client'
        )
        .requiredOption(
            '-m, --mnemonic <mnemonic>',
            'The mnemonic(s) used to generate spam accounts. Can be comma-separated for parallel funding'
        )
        .option(
            '-s, --sub-accounts <sub-accounts>',
            'The number of sub-accounts that will send out transactions',
            '10'
        )
        .option(
            '-t, --transactions <transactions>',
            'The total number of transactions to be emitted',
            '2000'
        )
        .option(
            '--mode <mode>',
            'The mode for the stress test. Possible modes: [EOA, ERC20, ERC721]',
            'EOA'
        )
        .option(
            '-o, --output <output-path>',
            'The output path for the results JSON'
        )
        .option(
            '-b, --batch <batch>',
            'The batch size of JSON-RPC transactions',
            '20'
        )
        .option(
            '--stats-file <filename>',
            'If set, only run stats calculation from the given txHashes JSON file and skip all prior actions.'
        )
        .parse();

    const options = program.opts();

    // If --stats-file is set, run stats calculation only
    if (options.statsFile) {
        if (!options.mnemonic) {
            Logger.error('Error: --mnemonic option is required when using --stats-file.');
            process.exit(1);
        }
        const fs = await import('fs');
        const txHashes = JSON.parse(fs.readFileSync(options.statsFile, 'utf8'));
        const batchSize = options.batch;
        const url = options.jsonRpc;
        const mnemonicInput = options.mnemonic;
        // Parse comma-separated mnemonics
        const mnemonics = mnemonicInput.split(',').map((m: string) => m.trim());
        const mainMnemonic = mnemonics[0];

        const output = options.output;
        Logger.info(`Loaded ${txHashes.length} txHashes from ${options.statsFile}`);
        const collectorData = await statCollector.generateStats(
            txHashes,
            mainMnemonic,
            url,
            batchSize
        );
        if (output) {
            Outputter.outputData(collectorData, output);
        }
        return;
    }

    // ...existing code for main test run...
    const url = options.jsonRpc;
    const transactionCount = options.transactions;
    const mode = options.mode;
    const mnemonicInput = options.mnemonic;
    const subAccountsCount = options.subAccounts;
    const batchSize = options.batch;
    const output = options.output;

    // Parse comma-separated mnemonics
    const mnemonics = mnemonicInput.split(',').map((m: string) => m.trim());
    const mainMnemonic = mnemonics[0];

    // Create funding wallets from all provided mnemonics
    const fundingWallets = mnemonics.map((mnemonic: string) =>
        Wallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/0`).connect(
            new JsonRpcProvider(url)
        )
    );

    let runtime: Runtime;
    switch (mode) {
        case RuntimeType.EOA:
            runtime = new EOARuntime(mainMnemonic, url);
            break;
        case RuntimeType.ERC20:
            runtime = new ERC20Runtime(mainMnemonic, url);
            await (runtime as InitializedRuntime).Initialize();
            break;
        case RuntimeType.ERC721:
            runtime = new ERC721Runtime(mainMnemonic, url);
            await (runtime as InitializedRuntime).Initialize();
            break;
        default:
            throw RuntimeErrors.errUnknownRuntime;
    }

    // Distribute the native currency funds
    const distributor = new Distributor(
        mainMnemonic,
        subAccountsCount,
        transactionCount,
        runtime,
        url
    );

    const accountIndexes: number[] = await distributor.distribute(fundingWallets);

    // Distribute the token funds, if any
    if (mode === RuntimeType.ERC20) {
        const tokenDistributor = new TokenDistributor(
            mainMnemonic,
            accountIndexes,
            transactionCount,
            runtime as TokenRuntime
        );
        await tokenDistributor.distributeTokens();
    }

    // Run the specific runtime
    const txHashes = await Engine.Run(
        runtime,
        new EngineContext(
            accountIndexes,
            transactionCount,
            batchSize,
            mainMnemonic,
            url
        )
    );

    // Dump txHashes to JSON file for later stats calculation
    const fs = await import('fs');
    const txHashesFilename = output ? output.replace(/\.json$/, '') + '_tx_hashes.json' : 'tx_hashes.json';
    fs.writeFileSync(txHashesFilename, JSON.stringify(txHashes, null, 2));
    Logger.success(`Dumped txHashes to ${txHashesFilename}`);

    // // Collect the data
    // const collectorData = await statCollector.generateStats(
    //     txHashes,
    //     mainMnemonic,
    //     url,
    //     batchSize
    // );

    // // Output the data if needed
    // if (output) {
    //     Outputter.outputData(collectorData, output);
    // }

    // Parse options and subcommands at the end
    program.parse(process.argv);
}

run()
    .then()
    .catch((err) => {
        Logger.error(err);
    });
