import { expect } from 'chai'
import { ethers } from "hardhat"

import { Signer, BigNumber } from "ethers"

import { TORNADO_TREES_GOERLI, TEST_TORN, SABLIER, AUCTION } from "../scripts/constants"

const base: BigNumber = BigNumber.from(10).pow(18)
const amount: BigNumber = (BigNumber.from(100)).mul(base)

describe('MerkleRootAuction', () => {
  let streamId: any

  it('Create stream', async() => {
    const latestBlockNumber = await ethers.provider.getBlockNumber()
    const latestBlock = await ethers.provider.getBlock(latestBlockNumber)

    const IERC20ABI = await ethers.getContractAt("contracts/interfaces/IERC20.sol:IERC20", TEST_TORN)
    const SablierRateAdjusterABI = await ethers.getContractFactory("SablierRateAdjuster")

    const SablierRateAdjuster = await SablierRateAdjusterABI.attach(SABLIER)
    const TestToken = await IERC20ABI.attach(TEST_TORN)

    await TestToken.approve(SABLIER, amount)

    const startTime = latestBlock.timestamp + 600
    const endTime = startTime + 100000

    await (await SablierRateAdjuster.createStream(
      AUCTION, amount, TEST_TORN, startTime, endTime,
      { gasLimit: 4200000 }
    )).wait().then((reciept: any) => {
      const { args }  = reciept.events[reciept.events.length-1]
      const id = args[args.length-7].toNumber()

      console.log(`Stream id: ${id}`)
      streamId = id
    })
  })

  it('Initialise stream', async() => {
    const MerkleRootAuctionABI = await ethers.getContractFactory("MerkleRootAuction")
    const MerkleRootAuction = await MerkleRootAuctionABI.attach(AUCTION)

    await MerkleRootAuction.initialiseStream(streamId)
  })

  it('Update roots', async() => {})
})
