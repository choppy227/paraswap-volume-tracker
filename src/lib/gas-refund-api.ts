import { TransactionRequest } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import _ from 'lodash';
import { assert } from 'ts-essentials';
import { GasRefundParticipation } from '../models/GasRefundParticipation';
import { GasRefundDistribution } from '../models/GasRefundDistribution';
import {
  CHAIN_ID_BINANCE,
  CHAIN_ID_FANTOM,
  CHAIN_ID_MAINNET,
  CHAIN_ID_POLYGON,
} from './constants';
import { EpochInfo } from './epoch-info';
import { GasRefundGenesisEpoch } from './gas-refund';
import { Provider } from './provider';

const MerkleRedeemAbi = [
  'function seedAllocations(uint _week, bytes32 _merkleRoot, uint _totalAllocation)',
  'function claimStatus(address _liquidityProvider, uint _begin, uint _end) external view returns (bool[] memory)',
];

interface MerkleRedeem extends Contract {
  callStatic: {
    claimStatus(
      _liquidityProvider: string,
      _begin: number,
      _end: number,
    ): Promise<boolean[]>;
  };
}

const MerkleRedeemAddress: { [chainId: number]: string } = {
  // @TODO
  [CHAIN_ID_MAINNET]: '0xdf8692b95790e26a36d89b9963f073caa18ef444',
  [CHAIN_ID_POLYGON]: '0x8144A5f1AF12fb966E6C3462B769E3a2109Ed658',
  [CHAIN_ID_FANTOM]: '0xf65Aac676C9600AbF56C5580b960e00e67369780',
  [CHAIN_ID_BINANCE]: '0xDB60678dA833d4AD29756BE04df7962038fa6c79',
};

type GasRefundClaim = Pick<
  GasRefundParticipation,
  'epoch' | 'address' | 'refundedAmountPSP' | 'merkleProofs'
>;

type BaseGasRefundClaimsResponse<T> = {
  totalClaimable: T;
  claims: (Omit<GasRefundClaim, 'refundedAmountPSP'> & { amount: string })[];
};
type GasRefundClaimsResponseAcc = BaseGasRefundClaimsResponse<bigint>;
type GasRefundClaimsResponse = BaseGasRefundClaimsResponse<string>;

export class GasRefundApi {
  epochInfo: EpochInfo;
  merkleRedem: MerkleRedeem;

  static instances: { [network: number]: GasRefundApi } = {};

  constructor(protected network: number) {
    this.epochInfo = EpochInfo.getInstance(CHAIN_ID_MAINNET);
    this.merkleRedem = new Contract(
      MerkleRedeemAddress[network],
      MerkleRedeemAbi,
      Provider.getJsonRpcProvider(this.network),
    ) as unknown as MerkleRedeem;
  }

  static getInstance(network: number): GasRefundApi {
    if (!this.instances[network])
      this.instances[network] = new GasRefundApi(network);
    return this.instances[network];
  }

  // retrieve merkle root + compute tx params for last epoch
  async gasRefundDataForEpoch(epoch: number): Promise<{
    data: GasRefundDistribution;
    txParams: TransactionRequest;
  } | null> {
    const data = await GasRefundDistribution.findOne({
      where: { chainId: this.network, epoch },
      attributes: ['merkleRoot', 'epoch', 'chainId', 'totalPSPAmountToRefund'],
      raw: true,
    });

    if (!data) return null;

    const { merkleRoot, totalPSPAmountToRefund } = data;

    const txData = this.merkleRedem.interface.encodeFunctionData(
      'seedAllocations',
      [epoch, merkleRoot, totalPSPAmountToRefund],
    );

    return {
      data,
      txParams: {
        to: MerkleRedeemAddress[this.network],
        data: txData,
        chainId: this.network,
      },
    };
  }

  async _fetchMerkleData(address: string): Promise<GasRefundClaim[]> {
    const grpData = await GasRefundParticipation.findAll({
      attributes: ['epoch', 'address', 'refundedAmountPSP', 'merkleProofs'],
      where: { address, chainId: this.network, isCompleted: true },
      raw: true,
    });

    return grpData;
  }

  async _getClaimStatus(
    address: string,
    startEpoch: number,
    endEpoch: number,
  ): Promise<Record<number, boolean>> {
    const claimStatus = await this.merkleRedem.callStatic.claimStatus(
      address,
      startEpoch,
      endEpoch,
    );

    const epochToClaimed = claimStatus.reduce<Record<number, boolean>>(
      (acc, claimed, index) => {
        acc[startEpoch + index] = claimed;
        return acc;
      },
      {},
    );

    assert(
      Object.keys(epochToClaimed).length == endEpoch - startEpoch + 1,
      'logic error',
    );

    return epochToClaimed;
  }

  // get all ever constructed merkle data for addrress
  async getAllGasRefundDataForAddress(
    address: string,
  ): Promise<GasRefundClaimsResponse> {
    const lastEpoch = (await this.epochInfo.getCurrentEpoch()) - 1;

    const startEpoch = GasRefundGenesisEpoch;
    const endEpoch = Math.max(lastEpoch, GasRefundGenesisEpoch);

    const [merkleData, epochToClaimed] = await Promise.all([
      this._fetchMerkleData(address),
      this._getClaimStatus(address, startEpoch, endEpoch),
    ]);

    const { totalClaimable, claims } =
      merkleData.reduce<GasRefundClaimsResponseAcc>(
        (acc, claim) => {
          if (epochToClaimed[claim.epoch]) return acc;

          const { refundedAmountPSP, ...rClaim } = claim;
          acc.claims.push({ ...rClaim, amount: refundedAmountPSP });
          acc.totalClaimable += BigInt(refundedAmountPSP);

          return acc;
        },
        {
          totalClaimable: BigInt(0),
          claims: [],
        },
      );

    return {
      totalClaimable: totalClaimable.toString(),
      claims,
    };
  }

  async getAllEntriesForEpoch(
    epoch: number,
  ): Promise<GasRefundParticipation[]> {
    const grpData = await GasRefundParticipation.findAll({
      where: { epoch, chainId: this.network },
      raw: true,
    });

    return grpData;
  }
}