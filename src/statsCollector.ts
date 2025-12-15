import Logger from './logger/logger';
import Outputter from './outputter/outputter';

import { StatCollector } from './stats/collector';

const BATCH = 1
const MNEMONIC = "below traffic trial damage flash click ripple occur increase december angle plate cream behind hybrid inform glow burger organ young escape arch region fiber"
const URL = "http://example.com:8545"
const STATS_FILE = "./example_stats.json"
const OUTPUT = "./example_output.json"

async function main() {
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

    const fs = await import('fs');
    const txHashes = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    const batchSize = BATCH;
    const url = URL;
    const mnemonicInput = MNEMONIC;
    // Parse comma-separated mnemonics
    const mnemonics = mnemonicInput.split(',').map((m: string) => m.trim());
    const mainMnemonic = mnemonics[0];

    const output = OUTPUT;
    Logger.info(`Loaded ${txHashes.length} txHashes from ${STATS_FILE}`);
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


main().then(() => {
    process.exit(0);
}).catch((err) => {
    Logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
});