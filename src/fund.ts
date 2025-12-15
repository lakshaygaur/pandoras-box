


import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import { BigNumber } from '@ethersproject/bignumber';
import Logger from './logger/logger';

const funder = "below traffic trial damage flash click ripple occur increase december angle plate cream behind hybrid inform glow burger organ young escape arch region fiber";

const mnemonics = [
    "lunch boy rocket lonely nephew stock impose industry there myth success trim scheme learn fruit return heart reject police market call clarify attract access",
    "point radar bulk now myself near have moment diary noodle practice sheriff sell alert session lucky angry hand service again brass resource win dynamic",
    "hollow notice casual aerobic service cycle limb ugly dust fire trap lemon solve extend escape cover tragic barrel south alpha weekend oxygen night polar",
    "book ignore warm horse cereal burger grant spell deposit correct tuition deposit festival session dry govern film income nerve wall angry boost wish jealous",
    "fancy crew spy poverty pepper cluster since ride visual wrist cloth flash split approve tube side picture fix entry dilemma accident exhaust inmate cheese",
    "anchor apple letter what long march chapter distance sugar mass cactus human birth nominee author gather ripple lyrics marriage term invite differ parent toss",
    "junior noodle van despair cigar theory hill token punch start state ramp discover purse step absorb dutch horse outer lawn type defy cabbage point",
    "mammal inspire such sleep remember decorate dentist tackle tiny agree jar problem stool educate bonus public rent nation random still menu hole hard border",
];

/**
 * Dummy funder function, replace with your actual funder logic if needed
 */
async function funderTransfer(fromWallet: Wallet, toAddress: string, amount: BigNumber, provider: JsonRpcProvider) {
    const tx = await fromWallet.sendTransaction({
        to: toAddress,
        value: amount,
    });
    await tx.wait();
    Logger.success(`Funded ${toAddress} with ${amount.toString()} wei, txHash=${tx.hash}`);
}

/**
 * Reads mnemonics from the array and funds each address with 100k wei from the funder wallet.
 * @param mnemonics Array of mnemonic strings
 * @param funderMnemonic Mnemonic of the wallet to fund from
 * @param providerUrl RPC URL
 */
export async function fundMnemonics(mnemonics: string[], funderMnemonic: string, providerUrl: string) {
    const provider = new JsonRpcProvider(providerUrl);
    const funderWallet = Wallet.fromMnemonic(funderMnemonic).connect(provider);
    // 100,000 ETH in wei
    const amount = BigNumber.from('100000').mul(BigNumber.from('1000000000000000000'));

    const wallets = mnemonics.map(mnemonic => Wallet.fromMnemonic(mnemonic).connect(provider));

    for (const wallet of wallets) {
        await funderTransfer(funderWallet, wallet.address, amount, provider);
    }

    // Print balance of each wallet in ETH after funding
    for (const wallet of wallets) {
        const balanceWei = await provider.getBalance(wallet.address);
        // Convert to string, pad with zeros, and format with commas
        const balanceEthStr = balanceWei.toString().padStart(18, '0');
        const ethWhole = balanceEthStr.length > 18 ? balanceEthStr.slice(0, -18) : '0';
        const ethFraction = balanceEthStr.length > 18 ? balanceEthStr.slice(-18) : balanceEthStr.padStart(18, '0');
        // Add commas to whole part
        const ethWholeFormatted = ethWhole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        Logger.info(`Wallet ${wallet.address} balance: ${ethWholeFormatted}.${ethFraction} ETH`);
    }
}

// usage:
const providerUrl = "http://example.com:8545";
fundMnemonics(mnemonics, funder, providerUrl);