import {
  Table,
  Model,
  Column,
  AllowNull,
  PrimaryKey,
  DataType,
  AutoIncrement,
  createIndexDecorator,
  Index,
} from 'sequelize-typescript';
import { EpochGasRefundData } from '../lib/gas-refund';

import {
  DataType_ADDRESS,
  DataType_KECCAK256_HASHED_VALUE,
} from '../lib/sql-data-types';

const compositeIndex = createIndexDecorator({
  name: 'epochgasrefund_epoch_address_chain',
  type: 'UNIQUE',
  unique: true,
});

@Table
export class GasRefundParticipation extends Model<EpochGasRefundData> {
  @PrimaryKey
  @AutoIncrement
  @Column(DataType.INTEGER)
  id: number;

  @compositeIndex
  @Column(DataType.SMALLINT)
  epoch: number;

  @compositeIndex
  @Column(DataType_ADDRESS)
  address: string;

  @compositeIndex
  @Column(DataType.SMALLINT)
  chainId: number;

  @Column(DataType.BOOLEAN)
  isCompleted: boolean;

  @Column(DataType.INTEGER)
  firstBlock: number; // @debug

  @Index
  @Column(DataType.INTEGER)
  lastBlock: number;

  @Column(DataType_KECCAK256_HASHED_VALUE)
  firstTx: string; // @debug

  @Column(DataType_KECCAK256_HASHED_VALUE)
  lastTx: string; // @debug

  @Column(DataType.SMALLINT)
  numTx: number; // @debug

  @Column(DataType.BIGINT)
  accumulatedGasUsed: string; // @debug

  @Column(DataType.DECIMAL)
  accumulatedGasUsedChainCurrency: string; // @debug

  @Column(DataType.DECIMAL)
  accumulatedGasUsedPSP: string;

  @AllowNull(true)
  @Column(DataType.DECIMAL)
  totalStakeAmountPSP: string; // @debug

  @AllowNull(true)
  @Column(DataType.DECIMAL)
  refundedAmountPSP: string;

  @AllowNull(true)
  @Column({
    type: DataType.ARRAY(DataType_KECCAK256_HASHED_VALUE),
  })
  merkleProofs: string[];
}
