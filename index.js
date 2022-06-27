require('dotenv').config();
const flashbots = require("@flashbots/ethers-provider-bundle");
const ethers = require('ethers');
const AWSHttpProvider = require('@aws/web3-http-provider');
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID, 
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
};


const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "http://127.0.0.1:8545";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || ethers.Wallet.createRandom().privateKey;

const provider = new ethers.providers.Web3Provider(new AWSHttpProvider(ETHEREUM_RPC_URL, { clientConfig: { credentials: credentials }}), 1);
const signingWallet = new ethers.Wallet(PRIVATE_KEY, provider);
const flashbotsRelaySigningWallet = new ethers.Wallet(FLASHBOTS_RELAY_SIGNING_KEY, provider);

const v2FactoryAddress = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const v2FactoryContract = new ethers.Contract(v2FactoryAddress, require('./abis/UniswapV2Factory').factory, provider);

const v2RouterAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const v2RouterContract = new ethers.Contract(v2RouterAddress, require('./abis/UniswapV2Router').router, signingWallet);


const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

async function createV2Bundle(pairAddress) {
    const signingAddress = await signingWallet.getAddress();
    const v2Pair = new ethers.Contract(pairAddress, require('./abis/UniswapV2Pair').pair, provider);
    const token0 = await v2Pair.token0();
    const token1 = await v2Pair.token1();


    if (token0 == WETH || token1 == WETH) {

        var token = token0;
        var wethIndex = 0;
        if(token0 == WETH) {
            token = token1;
        } else {
            wethIndex = 1;
        }

        var reserves = await v2Pair.getReserves();
        const tokenContract = new ethers.Contract(token, require('./abis/ERC20').token, signingWallet);
        const tokenName = await tokenContract.name();
        console.log('new pair found:\t WETH /', tokenName, '\t liquidity:', ethers.utils.formatEther(reserves[wethIndex]));

        if(reserves[wethIndex] > 0) {
            console.log(`${tokenName} has added ${ethers.utils.formatEther(reserves[wethIndex])} eth as liquidity!`);

            const block = await provider.getBlock("latest");
            const maxBaseFeeInFutureBlock = flashbots.FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(block.baseFeePerGas, 1);
            const priorityFee = ethers.BigNumber.from(10).pow(9);

            const amountToBuy = ethers.utils.parseEther('0.03');
            const maxSpend = ethers.utils.parseEther('0.05');

            const amountTokenOut = await v2RouterContract.getAmountsOut(amountToBuy, [WETH, token]);
            const swapETHForExactTokens = await v2RouterContract.populateTransaction.swapETHForExactTokens(
                amountTokenOut[1],
                [WETH, token],
                signingAddress,
                block.timestamp + 15, {
                value: maxSpend,
                type: 2,
                maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
                maxPriorityFeePerGas: priorityFee,
                gasLimit: 330000,
            });
            swapETHForExactTokens.chainId = 1;

            // const balance = await tokenContract.populateTransaction.balanceOf(signingAddress);
            const approveTx = await tokenContract.populateTransaction.approve(v2RouterAddress, amountTokenOut[1], {
                type: 2,
                maxPriorityFeePerGas: priorityFee,
                maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
                gasLimit: 70000
            });
            approveTx.chainId = 1;
            // const amountETHOut = await v2RouterContract.populateTransaction.getAmountsOut(balance, [token0, WETH]);
            const sellTx = await v2RouterContract.populateTransaction.swapExactTokensForETH(
                amountTokenOut[1],
                amountTokenOut[0].div(ethers.BigNumber.from(100)),
                [token, WETH],
                signingAddress,
                block.timestamp + 15, {
                maxPriorityFeePerGas: priorityFee,
                maxFeePerGas: priorityFee.add(maxBaseFeeInFutureBlock),
                type: 2,
                gasLimit: 200000
            });
            sellTx.chainId = 1;

            const bundledTransactions = [
                {
                    signer: signingWallet,
                    transaction: swapETHForExactTokens
                },
                {
                    signer: signingWallet,
                    transaction: approveTx
                },
                {
                    signer: signingWallet,
                    transaction: sellTx
                }
                ];
            return bundledTransactions;
        }
    }

    return null;

}

async function buyV2Token(pairAddress, bundle) {
    const buyTx = bundle[0].transaction;
    console.log('buying pair:', pairAddress);
    const tx = await signingWallet.sendTransaction(buyTx);
    console.log(tx);

}

async function main() {
    console.log("Searcher Wallet Address: " + await signingWallet.getAddress())
    console.log("Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress());
    const flashbotsProvider = await flashbots.FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);

    let prevAmountPairs = ethers.BigNumber.from(await v2FactoryContract.allPairsLength()).toNumber();
    provider.on('block', async (blockNumber) => {
        const amountPairs = ethers.BigNumber.from(await v2FactoryContract.allPairsLength()).toNumber();
        console.log('block:', blockNumber, 'lastPairCount:', prevAmountPairs, 'currPairCount:', amountPairs);
        
        if (amountPairs > prevAmountPairs) {
            for(let i = prevAmountPairs; i < amountPairs; i++) {
                const newPairAddress = await v2FactoryContract.allPairs(i);
                var bundle = await createV2Bundle(newPairAddress);
                if(bundle != null) {
                    console.log('running simulation...');
                    const signedBundle = await flashbotsProvider.signBundle(bundle);
                    const simulation = await flashbotsProvider.simulate(signedBundle, blockNumber + 1);
                    console.log(simulation.results);
                    if ("error" in simulation || simulation.firstRevert !== undefined) {
                        console.log(`simulation failed on pair ${newPairAddress}, skipping...`);
                    } else {
                        console.log('simulation held true on pair', newPairAddress, 'proceeding...');
                        await buyV2Token(newPairAddress, bundle);
                    }
                    prevAmountPairs = i + 1;
                    break;
                }
            }
            // prevAmountPairs = amountPairs;
        }
    });
}
main();