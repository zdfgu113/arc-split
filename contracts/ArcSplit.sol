// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Atomic native-USDC payouts on Arc. No admin, fee, or withdrawal path.
contract ArcSplit {
    error InvalidRecipients();
    error InvalidAmount();
    error InvalidReference();
    error DuplicatePayment();
    error NoteTooLong();
    error TransferFailed(uint256 index);

    mapping(address => mapping(bytes32 => bool)) public paid;

    event SplitPaid(
        address indexed payer,
        bytes32 indexed referenceId,
        uint256 total,
        address[] recipients,
        uint256[] amounts,
        string note
    );

    function split(
        address[] calldata recipients,
        uint256[] calldata amounts,
        bytes32 referenceId,
        string calldata note
    ) external payable {
        uint256 count = recipients.length;
        if (count < 2 || count > 10 || count != amounts.length) revert InvalidRecipients();
        if (referenceId == bytes32(0)) revert InvalidReference();
        if (paid[msg.sender][referenceId]) revert DuplicatePayment();
        if (bytes(note).length > 96) revert NoteTooLong();

        uint256 total;
        for (uint256 i; i < count; ++i) {
            if (recipients[i] == address(0) || recipients[i] == address(this)) revert InvalidRecipients();
            if (amounts[i] == 0) revert InvalidAmount();
            for (uint256 j; j < i; ++j) {
                if (recipients[i] == recipients[j]) revert InvalidRecipients();
            }
            total += amounts[i];
        }
        if (total != msg.value || total == 0) revert InvalidAmount();

        // Record before external calls; any failed payout rolls back this entire payment.
        paid[msg.sender][referenceId] = true;
        for (uint256 i; i < count; ++i) {
            (bool success,) = payable(recipients[i]).call{value: amounts[i]}("");
            if (!success) revert TransferFailed(i);
        }
        emit SplitPaid(msg.sender, referenceId, total, recipients, amounts, note);
    }
}
