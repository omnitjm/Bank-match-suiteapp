/**
 * BM_Proposal_UE.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType UserEventScript
 *
 * User Event on customrecord_bm_proposal.
 *
 * afterSubmit – when status changes to APPROVED, executes the reconciliation
 *               with full idempotency and concurrency protection:
 *
 *   1. Early-exit if apply_status is already Processing or Applied.
 *   2. Set apply_status = Processing, increment apply_attempts.
 *   3. Execute engine based on txn_type:
 *        '1' CUSTOMER_PAYMENT → applyCustomerPayment (Invoice → Customer Payment)
 *        '2' VENDOR_PAYMENT   → applyVendorPayment   (Vendor Bill → Vendor Payment)
 *        '3' JOURNAL_ENTRY    → applyJournalEntry    (GL Account → Journal Entry)
 *   4. Set custbody_bank_transaction_id on the resulting NS transaction.
 *      Value is normalizeTxnId(bankRef) — trimmed, uppercased.
 *   5. Mark proposal Applied (or Failed) and record the NS txn ID.
 *
 * IMPORTANT:
 *   tranid is NEVER written here.
 *   custbody_bank_transaction_id is the sole field used for bank matching.
 *   After proposals are applied, NetSuite's native Reconciliation Rules
 *   automatically reconcile transactions stamped with this field.
 */
define([
    'N/record',
    'N/search',
    'N/log',
    './BM_Constants',
    './BM_MatchEngine'
], function (record, search, log, C, engine) {
    'use strict';

    var PF = C.PROPOSAL_FIELDS;
    var PS = C.PROPOSAL_STATUS;
    var AS = C.APPLY_STATUS;
    var TS = C.TXN_STATUS;
    var BF = C.BODY_FIELD;

    // ── Load settings (needed for Journal Entry to get bank GL account) ────
    function _getSettings() {
        var SF = C.SETTINGS_FIELDS;
        var rows = search.create({
            type:    C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
            columns: [SF.BANK_ACCOUNT]
        }).run().getRange({ start: 0, end: 1 });

        if (!rows || !rows.length) return null;
        var r = rows[0];
        return { bankAccount: r.getValue(SF.BANK_ACCOUNT) };
    }

    // ── beforeLoad ────────────────────────────────────────────────────────
    function beforeLoad(context) {
        if (context.type !== context.UserEventType.VIEW &&
            context.type !== context.UserEventType.EDIT) return;
        // Approver edits the Status field directly on the record.
    }

    // ── afterSubmit ───────────────────────────────────────────────────────
    function afterSubmit(context) {
        if (context.type === context.UserEventType.DELETE) return;

        var newRec    = context.newRecord;
        var newStatus = newRec.getValue(PF.STATUS);

        // Only proceed when status just became APPROVED
        if (newStatus !== PS.APPROVED) return;

        // Prevent re-entry: if old status was already Approved or Applied, skip
        if (context.oldRecord) {
            var oldStatus = context.oldRecord.getValue(PF.STATUS);
            if (oldStatus === PS.APPROVED || oldStatus === PS.APPLIED) return;
        }

        var proposalId = newRec.id;
        log.audit('BM_Proposal_UE', 'Proposal ' + proposalId + ' approved – starting apply');

        // ── Concurrency lock ──────────────────────────────────────────────
        var freshRec;
        try {
            freshRec = record.load({ type: C.RECORDS.PROPOSAL, id: proposalId });
        } catch (loadErr) {
            log.error('BM_Proposal_UE',
                'Could not load proposal for lock check: ' + loadErr.message);
            return;
        }

        var freshApplyStatus = freshRec.getValue(PF.APPLY_STATUS);
        if (freshApplyStatus === AS.APPLIED) {
            log.audit('BM_Proposal_UE', 'Proposal ' + proposalId + ' already Applied – skipping');
            return;
        }
        if (freshApplyStatus === AS.PROCESSING) {
            log.audit('BM_Proposal_UE', 'Proposal ' + proposalId + ' already Processing – skipping');
            return;
        }

        // Claim the lock
        var currentAttempts = parseInt(freshRec.getValue(PF.APPLY_ATTEMPTS), 10) || 0;
        record.submitFields({
            type:    C.RECORDS.PROPOSAL,
            id:      proposalId,
            values:  {
                [PF.APPLY_STATUS]:   AS.PROCESSING,
                [PF.APPLY_ATTEMPTS]: currentAttempts + 1
            },
            options: { ignoreMandatoryFields: true }
        });

        // ── Gather proposal data ──────────────────────────────────────────
        var proposal = {
            proposalId:  proposalId,
            nsId:        newRec.getValue(PF.NS_RECORD_ID),
            nsType:      newRec.getValue(PF.NS_RECORD_TYPE),
            txnType:     newRec.getValue(PF.TXN_TYPE),
            bankAmount:  newRec.getValue(PF.BANK_AMOUNT),
            bankDate:    newRec.getValue(PF.BANK_DATE),
            bankRef:     newRec.getValue(PF.BANK_REF),
            bankTxnId:   newRec.getValue(PF.BANK_TXN)
        };

        // Normalized bank reference — written to custbody_bank_transaction_id
        var normRef   = C.normalizeTxnId(proposal.bankRef);
        var errorMsg  = null;
        var appliedId = null;

        // ── Execute reconciliation ────────────────────────────────────────
        try {
            if (String(proposal.txnType) === String(C.TXN_TYPE.CUSTOMER_PAYMENT)) {

                // Create Customer Payment applied to the Invoice
                appliedId = engine.applyCustomerPayment(proposal);

                // Stamp custbody_bank_transaction_id
                if (normRef && appliedId) {
                    record.submitFields({
                        type:    record.Type.CUSTOMER_PAYMENT,
                        id:      appliedId,
                        values:  { [BF.BANK_TXN_ID]: normRef },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                }

            } else if (String(proposal.txnType) === String(C.TXN_TYPE.VENDOR_PAYMENT)) {

                // Create Vendor Payment applied to the Vendor Bill
                appliedId = engine.applyVendorPayment(proposal);

                // Stamp custbody_bank_transaction_id
                if (normRef && appliedId) {
                    record.submitFields({
                        type:    record.Type.VENDOR_PAYMENT,
                        id:      appliedId,
                        values:  { [BF.BANK_TXN_ID]: normRef },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                }

            } else if (String(proposal.txnType) === String(C.TXN_TYPE.JOURNAL_ENTRY)) {

                // Load settings to get the bank GL account
                var settings = _getSettings();
                if (!settings || !settings.bankAccount) {
                    throw new Error(
                        'Bank GL account not configured in Bank Match Settings ' +
                        '— cannot create Journal Entry'
                    );
                }

                // Create Journal Entry
                appliedId = engine.applyJournalEntry(proposal, settings.bankAccount);

                // Stamp custbody_bank_transaction_id
                if (normRef && appliedId) {
                    record.submitFields({
                        type:    record.Type.JOURNAL_ENTRY,
                        id:      appliedId,
                        values:  { [BF.BANK_TXN_ID]: normRef },
                        options: { enableSourcing: false, ignoreMandatoryFields: true }
                    });
                }

            } else {
                throw new Error('Unknown transaction type: ' + proposal.txnType);
            }

        } catch (e) {
            errorMsg = e.message;
            log.error('BM_Proposal_UE',
                'Reconciliation failed for proposal ' + proposalId + ': ' + e.message);
        }

        // ── Write result back to proposal ─────────────────────────────────
        var resultValues = {};
        if (errorMsg) {
            resultValues[PF.STATUS]       = PS.FAILED;
            resultValues[PF.ERROR_MSG]    = errorMsg;
            resultValues[PF.APPLY_STATUS] = AS.FAILED;
            resultValues[PF.APPLY_ERROR]  = errorMsg;
        } else {
            resultValues[PF.STATUS]         = PS.APPLIED;
            resultValues[PF.APPLIED_DATE]   = new Date();
            resultValues[PF.ERROR_MSG]      = '';
            resultValues[PF.APPLY_STATUS]   = AS.APPLIED;
            resultValues[PF.APPLIED_TXN_ID] = String(appliedId || '');
        }

        record.submitFields({
            type:    C.RECORDS.PROPOSAL,
            id:      proposalId,
            values:  resultValues,
            options: { ignoreMandatoryFields: true }
        });

        // ── Update bank transaction status (if linked to a custom record) ──
        if (!errorMsg && proposal.bankTxnId) {
            try {
                var txnUpdate = {};
                txnUpdate[C.BANK_TXN_FIELDS.STATUS] = TS.RECONCILED;
                record.submitFields({
                    type:    C.RECORDS.BANK_TXN,
                    id:      proposal.bankTxnId,
                    values:  txnUpdate,
                    options: { ignoreMandatoryFields: true }
                });
            } catch (e2) {
                log.error('BM_Proposal_UE',
                    'Could not update bank txn status: ' + e2.message);
            }
        }

        log.audit('BM_Proposal_UE',
            'Proposal ' + proposalId + ' result: ' +
            (errorMsg ? 'FAILED' : 'APPLIED') +
            (appliedId ? ' (NS ID ' + appliedId + ')' : ''));
    }

    return {
        beforeLoad:  beforeLoad,
        afterSubmit: afterSubmit
    };
});
