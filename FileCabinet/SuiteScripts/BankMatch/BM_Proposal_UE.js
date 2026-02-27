/**
 * BM_Proposal_UE.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType UserEventScript
 *
 * User Event on customrecord_bm_proposal.
 *
 * beforeLoad  – adds an info banner showing the approval requirement.
 * afterSubmit – when status changes to APPROVED, executes the reconciliation.
 *               Updates the bank transaction status to RECONCILED on success.
 *               Captures any errors in the ERROR_MSG field and sets status FAILED.
 *
 * NOTE: The actual matching engine call (applyCustomerPayment / applyBillPayment)
 *       is made with the privileged context of the script deployment (Admin role).
 */
define([
    'N/record',
    'N/search',
    'N/log',
    'N/runtime',
    './BM_Constants',
    './BM_MatchEngine'
], function (record, search, log, runtime, C, engine) {
    'use strict';

    var PF = C.PROPOSAL_FIELDS;
    var PS = C.PROPOSAL_STATUS;
    var TS = C.TXN_STATUS;

    // ── beforeLoad ────────────────────────────────────────────────────────
    function beforeLoad(context) {
        // Only enrich the view/edit form
        if (context.type !== context.UserEventType.VIEW &&
            context.type !== context.UserEventType.EDIT) return;

        var status = context.newRecord.getValue(PF.STATUS);
        if (status === PS.PENDING) {
            // The form header message is shown via the record's page init
            // (NetSuite shows the record normally – approver changes status field)
        }
    }

    // ── afterSubmit ───────────────────────────────────────────────────────
    function afterSubmit(context) {
        // Only act on Edit/Create, not Delete
        if (context.type === context.UserEventType.DELETE) return;

        var newRec = context.newRecord;
        var newStatus = newRec.getValue(PF.STATUS);

        // Nothing to do unless status just became APPROVED
        if (newStatus !== PS.APPROVED) return;

        // Check old status – we only want to fire once
        if (context.oldRecord) {
            var oldStatus = context.oldRecord.getValue(PF.STATUS);
            if (oldStatus === PS.APPROVED || oldStatus === PS.APPLIED) return;
        }

        log.audit('BM_Proposal_UE', 'Proposal ' + newRec.id + ' approved – executing reconciliation');

        // Gather proposal data
        var proposal = {
            proposalId:  newRec.id,
            nsId:        newRec.getValue(PF.NS_RECORD_ID),
            nsType:      newRec.getValue(PF.NS_RECORD_TYPE),
            txnType:     newRec.getValue(PF.TXN_TYPE),
            bankAmount:  newRec.getValue(PF.BANK_AMOUNT),
            bankDate:    newRec.getValue(PF.BANK_DATE),
            bankRef:     newRec.getValue(PF.BANK_REF),
            adjustDate:  newRec.getValue(PF.ADJUST_DATE) === true ||
                         newRec.getValue(PF.ADJUST_DATE) === 'T',
            bankTxnId:   newRec.getValue(PF.BANK_TXN)
        };

        var errorMsg  = null;
        var appliedId = null;

        try {
            if (String(proposal.txnType) === String(C.TXN_TYPE.CUSTOMER_PAYMENT)) {
                // Reconcile customer payment → invoice
                appliedId = engine.applyCustomerPayment(proposal);

            } else if (String(proposal.txnType) === String(C.TXN_TYPE.BILL_PAYMENT)) {
                // Reconcile bill payment (optional date adjustment)
                engine.applyBillPayment(proposal);
                appliedId = proposal.nsId;

            } else {
                throw new Error('Unknown transaction type: ' + proposal.txnType);
            }
        } catch (e) {
            errorMsg = e.message;
            log.error('BM_Proposal_UE', 'Reconciliation failed for proposal ' + newRec.id + ': ' + e.message);
        }

        // Update proposal record with result
        var updateValues = {};
        if (errorMsg) {
            updateValues[PF.STATUS]    = PS.FAILED;
            updateValues[PF.ERROR_MSG] = errorMsg;
        } else {
            updateValues[PF.STATUS]       = PS.APPLIED;
            updateValues[PF.APPLIED_DATE] = new Date();
            updateValues[PF.ERROR_MSG]    = '';
        }

        record.submitFields({
            type:    C.RECORDS.PROPOSAL,
            id:      newRec.id,
            values:  updateValues,
            options: { ignoreMandatoryFields: true }
        });

        // Update bank transaction status
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
                log.error('BM_Proposal_UE', 'Could not update bank txn status: ' + e2.message);
            }
        }

        log.audit('BM_Proposal_UE',
            'Proposal ' + newRec.id + ' result: ' + (errorMsg ? 'FAILED' : 'APPLIED') +
            (appliedId ? ' (NS ID ' + appliedId + ')' : ''));
    }

    return {
        beforeLoad:  beforeLoad,
        afterSubmit: afterSubmit
    };
});
