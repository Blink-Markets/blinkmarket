// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @notice Token governance whose only possible action is adopting the next registry generation after a delay.
contract BlinkGovernor is Governor, GovernorSettings, GovernorCountingSimple, GovernorVotes, GovernorVotesQuorumFraction {
    error WrongChain();
    error OnlySuccessorProposals();
    error InvalidSuccessor();
    event SuccessorAdopted(address indexed registry, uint64 effectiveAt);

    uint64 public immutable adoptionDelay;
    address public previousSuccessor;
    address public pendingSuccessor;
    uint64 public successorEffectiveAt;

    constructor(
        IVotes token_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumFraction_,
        uint64 adoptionDelay_
    )
        Governor("Blink Governor")
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(quorumFraction_)
    {
        if (block.chainid != 84532) revert WrongChain();
        adoptionDelay = adoptionDelay_;
    }

    function adoptSuccessor(address registry) external onlyGovernance {
        if (registry == address(0)) revert InvalidSuccessor();
        previousSuccessor = successor(); // a not-yet-effective earlier adoption is replaced, not promoted
        pendingSuccessor = registry;
        successorEffectiveAt = uint64(block.timestamp) + adoptionDelay;
        emit SuccessorAdopted(registry, successorEffectiveAt);
    }

    function successor() public view returns (address) {
        return block.timestamp >= successorEffectiveAt ? pendingSuccessor : previousSuccessor;
    }

    /// @dev Every proposal is created here, so this one filter also keeps relay and the setters unreachable.
    function _propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        address proposer
    ) internal override returns (uint256) {
        if (targets.length != calldatas.length) {
            revert GovernorInvalidProposalLength(targets.length, calldatas.length, values.length);
        }
        for (uint256 i = 0; i < targets.length; ++i) {
            if (
                targets[i] != address(this) || calldatas[i].length < 4
                    || bytes4(calldatas[i]) != this.adoptSuccessor.selector
            ) revert OnlySuccessorProposals();
        }
        return super._propose(targets, values, calldatas, description, proposer);
    }

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(timepoint);
    }
}
