import { toFixedHex, poseidonHash2, randomBN } from "../scripts/utils"
import MerkleTree from "fixed-merkle-tree"
import controller from "../scripts/controller"

import { expect } from "chai"
import { ethers, web3, artifacts } from "hardhat"
import { poseidon } from "circomlib"
import fs from "fs"

import { Signer, BigNumber } from "ethers"

import { TORNADO_TREES_GOERLI, TEST_TORN, SABLIER, AUCTION, TREE_DEPTH, TREE_HEIGHT } from "../scripts/constants"

const base: BigNumber = BigNumber.from(10).pow(18)
const amount: BigNumber = (BigNumber.from(100)).mul(base)

const PATH_TREE_UPDATE = "/home/alpha/tornado-cash-merkle-root-auction/artifacts/circuits/BatchTreeUpdate"
const PATH_TREES = "contracts/interfaces/ITornadoTrees.sol:ITornadoTrees"
const PATH_ERC = "contracts/interfaces/IERC20.sol:IERC20"
const TREES_BLOCK_DEPLOY = 4912105

const poseidonHash = (items) => BigNumber.from(poseidon(items)).toHexString()
const poseidonHash2 = (a, b) => poseidonHash([a, b])

interface Event {
  block: Number;
  hash: String;
  instance: String;
  index: Number;
}

async function getPastEvents(event, targetLeaf): Promise<Event[]> {
  const ITornadoTreesABI = artifacts.require("ITornadoTrees")
  const TornadoTrees = new web3.eth.Contract(ITornadoTreesABI.abi, TORNADO_TREES_GOERLI)

  let targetEvents = await TornadoTrees.getPastEvents(event, {
    fromBlock: TREES_BLOCK_DEPLOY,
    toBlock: 'latest'
  })

  let sortedEvents = targetEvents
  .sort((a, b) => a.returnValues.index - b.returnValues.index)
  .map((e) => ({
       instance: toFixedHex(e.returnValues.instance, 20),
       block: toFixedHex(e.returnValues.block, 4),
       hash: toFixedHex(e.returnValues.hash),
       index: e.returnValues.index
     })
   )

  const lastIndex = getMerkleIndex(sortedEvents, targetLeaf)
  const pendingLeaves = sortedEvents.slice(lastIndex, sortedEvents.length)

  return trimLeaves(pendingLeaves)
 }

 function trimLeaves(pendingLeaves): Array<Event> {
   const leavesPow = Math.log2(pendingLeaves.length)
   const sufficientPow = Math.floor(leavesPow)
   const trimmedLeaves = 2 ** sufficientPow
   const leafDiff = pendingLeaves.length - trimmedLeaves

   if(!Number.isInteger(leavesPow)){
     return pendingLeaves.slice(0, pendingLeaves.length - leafDiff)
   } else {
     return pendingLeaves
   }
 }

function getMerkleIndex(events, lastLeaf): number {
  const targetEvent = events.find(e => e.index === lastLeaf.toString())
  // const merkleTree = new MerkleTree(20, hashedEvents, { hashFunction: poseidonHash2 })

  return events.indexOf(targetEvent)
}

async function generateProofs(withdrawalEvents, depositEvents): Promise<any[2][2]> {
   const DEPOSIT_TREE = new MerkleTree(20, [], { hashFunction: poseidonHash2 })
   const WITHDRAWAL_TREE = new MerkleTree(20, [], { hashFunction: poseidonHash2 })
   const snarkWithdrawals = controller.batchTreeUpdate(WITHDRAWAL_TREE, withdrawalEvents)
   const snarkDeposits = controller.batchTreeUpdate(DEPOSIT_TREE, depositEvents)

   const proofWithdrawals = await controller.prove(
     snarkWithdrawals.input, PATH_TREE_UPDATE, "withdrawals"
   )
   const proofDeposits = await controller.prove(
      snarkDeposits.input, PATH_TREE_UPDATE, "deposits"
   )

   return [
      [ proofDeposits, proofWithdrawals ],
      [ snarkDeposits.args, snarkWithdrawals.args ]
   ]
}

describe('MerkleRootAuction', () => {
  let streamId: any

  it('Create stream', async() => {
    const latestBlockNumber = await ethers.provider.getBlockNumber()
    const latestBlock = await ethers.provider.getBlock(latestBlockNumber)

    const IERC20ABI = await ethers.getContractAt(PATH_ERC, TEST_TORN)
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

  it('Update roots', async() => {
     const MerkleRootAuctionABI = await ethers.getContractFactory("MerkleRootAuction")
     const MerkleRootAuction = await MerkleRootAuctionABI.attach(AUCTION)
     const TornadoTrees = await ethers.getContractAt(PATH_TREES, TORNADO_TREES_GOERLI)
     const CHUNK_SIZE = 2 ** TREE_HEIGHT

     const lastProcessedWithdrawal = await TornadoTrees.lastProcessedWithdrawalLeaf()
     const lastProcessedDeposit = await TornadoTrees.lastProcessedDepositLeaf()

     const withdrawals = await getPastEvents("WithdrawalData", lastProcessedWithdrawal)
     const deposits = await getPastEvents("DepositData", lastProcessedDeposit)
     const totalEvents = withdrawals.length + deposits.length
     const numBatches = (totalEvents / CHUNK_SIZE) - 1

     for(var x = 0 ; x < /* numBatches */  1 * CHUNK_SIZE; x += CHUNK_SIZE){
       const batchWithdrawals = withdrawals.slice(x, x + CHUNK_SIZE)
       const batchDeposits = deposits.slice(x, x + CHUNK_SIZE)

       const [ proofs, args ] = await generateProofs(batchDeposits, batchWithdrawals)
       const hexProofs = proofs.map(e => BigNumber.from(e).toHexString())

       console.log('WITHDRAWAL PROOF:', hexProofs[0])
       console.log('DEPOSIT PROOF:', hexProofs[1])

       const parameters = await args[0].map((e, i) => [ e, args[1][i] ])

       const tx = (await MerkleRootAuction.updateRoots(
         hexProofs, ...parameters,
         { gasLimit: 6750000 }
       )).wait().then((reciept: any) => {
         console.log(reciept.transactionHash)
       })
     }
   })
})
