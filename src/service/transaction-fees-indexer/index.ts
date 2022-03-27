import '../../lib/log4js';
import * as dotenv from 'dotenv';
dotenv.config();
import { computeGasRefundByAddress } from './refund/gas-refund';
import { computeMerkleData } from './refund/merkle-tree';
import { fetchDailyPSPChainCurrencyRate } from './psp-chaincurrency-pricing';
import { computeAccumulatedTxFeesByAddress } from './transactions-indexing';
import { fetchPSPStakes } from './staking/staking';
import Database from '../../database';

import { writeCompletedEpochData } from './persistance/db-persistance';

import { GRP_SUPPORTED_CHAINS } from '../../lib/gas-refund-api';

const logger = global.LOGGER('GRP');

const epochNum = 8; // @TODO: read from EpochInfo
const epochStartTime = 1646654400; // @TODO: read from EpochInfo
const epochEndTime = 1647864000; // @TODO: read from EpochInfo

// @FIXME: we should invert the logic to first fetch stakers and then scan through their transactions as: len(stakers) << len(swappers)
// @FIXME: should cap amount distributed to stakers to 30k
export async function calculateGasRefundForChain({
  chainId,
  epoch,
}: {
  chainId: number;
  epoch: number;
}) {
  // retrieve daily psp/native currency rate for (epochStartTime, epochEndTime
  logger.info(
    `start fetching daily psp/native currency rate for chainId=${chainId}`,
  );
  const pspNativeCurrencyDailyRate = await fetchDailyPSPChainCurrencyRate({
    chainId,
    startTimestamp: epochStartTime,
    endTimestamp: epochEndTime,
  });

  // retrieve all tx beetween (start_epoch_timestamp, end_epoch_timestamp) +  compute progressively mapping(chainId => address => mapping(timestamp => accGasUsedPSP)) // address: txOrigin, timestamp: start of the day
  logger.info(`start computing accumulated tx fees for chainId=${chainId}`);

  const accTxFeesByAddress = await computeAccumulatedTxFeesByAddress({
    chainId,
    epoch,
    pspNativeCurrencyDailyRate,
    startTimestamp: epochStartTime,
    endTimestamp: epochEndTime,
  });

  // retrieve mapping(address => totalStakes) where address is in dailyTxFeesByAddressByChain
  logger.info(`start fetching psp stakes`);
  const swapperAddresses = [...new Set(Object.keys(accTxFeesByAddress))];

  const pspStakesByAddress = await fetchPSPStakes(swapperAddresses);

  // combine data to form mapping(chainId => address => {totalStakes@debug, gasRefundPercent@debug, accGasUsedPSP@debug, refundAmount})  // amount = accGasUsedPSP * gasRefundPercent
  logger.info(`reduce gas refund by address for chainId=${chainId}`);
  const gasRefundByAddress = await computeGasRefundByAddress(
    accTxFeesByAddress,
    pspStakesByAddress,
  );

  // compute mapping(networkId => MerkleTree)
  logger.info(`compute merkleTree for chainId=${chainId}`);
  const merkleTree = await computeMerkleData(
    chainId,
    gasRefundByAddress,
    epochNum,
  );

  // @TODO: store merkleTreeByChain in db (or file to start with) with epochNum
  console.log({ merkleTreeByChain: JSON.stringify(merkleTree) });
  // todo: determine if epoch is over (epoch endtime < [now])
  await writeCompletedEpochData(chainId, merkleTree, pspStakesByAddress);

  // await saveMerkleTree({ merkleTree, chainId, epochNum });
}

async function start() {
  await Database.connectAndSync();

  await Promise.all(
    GRP_SUPPORTED_CHAINS.map(chainId =>
      calculateGasRefundForChain({ chainId, epoch: epochNum }),
    ),
  );
}

start();
