// Copyright (c) Groundwork contributors
// SPDX-License-Identifier: MIT
//
// The shared-object and sender-authorization shape was informed by Mysten
// Labs' Apache-2.0 Sui escrow example. That example is an atomic object swap,
// not this paid-task contract. See docs/SUI_SOURCES.md for attribution.
module ask2human_escrow::job_escrow;

use std::option::{Self, Option};
use sui::clock::{Self, Clock};
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::sui::SUI;
use sui::transfer;
use sui::tx_context::{Self, TxContext};

const HASH_LENGTH: u64 = 32;

const EInvalidHash: u64 = 0;
const EInvalidAmount: u64 = 1;
const EDeadlinePassed: u64 = 2;
const ENotWorker: u64 = 3;
const EAlreadySubmitted: u64 = 4;
const ENotSubmitted: u64 = 5;
const ENotBuyer: u64 = 6;
const ENotExpired: u64 = 7;
const EAlreadySubmittedForRefund: u64 = 8;

/// A funded paid task. Its address is fixed at creation and its `Coin<SUI>`
/// is consumed together with the shared object by exactly one terminal call.
public struct Job has key {
    id: UID,
    funder: address,
    worker: address,
    brief_hash: vector<u8>,
    deadline_ms: u64,
    commitment_hash: Option<vector<u8>>,
    escrowed_sui: Balance<SUI>,
}

public struct JobCreated has copy, drop {
    job_id: ID,
    funder: address,
    worker: address,
    amount_mist: u64,
    brief_hash: vector<u8>,
    deadline_ms: u64,
}

public struct WorkSubmitted has copy, drop {
    job_id: ID,
    funder: address,
    worker: address,
    commitment_hash: vector<u8>,
    submitted_at_ms: u64,
}

public struct JobReleased has copy, drop {
    job_id: ID,
    funder: address,
    worker: address,
    amount_mist: u64,
}

public struct JobRefunded has copy, drop {
    job_id: ID,
    funder: address,
    worker: address,
    amount_mist: u64,
}

/// Escrow SUI for a fixed worker and a SHA-256 task-brief hash.
public fun create_and_fund(
    escrowed_sui: Coin<SUI>,
    worker: address,
    brief_hash: vector<u8>,
    deadline_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_hash(&brief_hash);
    let amount_mist = coin::value(&escrowed_sui);
    assert!(amount_mist > 0, EInvalidAmount);
    assert!(deadline_ms > clock::timestamp_ms(clock), EDeadlinePassed);

    let mut job = Job {
        id: object::new(ctx),
        funder: tx_context::sender(ctx),
        worker,
        brief_hash,
        deadline_ms,
        commitment_hash: option::none(),
        escrowed_sui: coin::into_balance(escrowed_sui),
    };

    event::emit(JobCreated {
        job_id: object::id(&job),
        funder: job.funder,
        worker: job.worker,
        amount_mist,
        brief_hash: job.brief_hash,
        deadline_ms,
    });
    transfer::share_object(job);
}

/// Record a SHA-256 commitment to the off-chain work. Only the fixed worker
/// can submit, and only before the funding deadline.
public fun submit(
    job: &mut Job,
    commitment_hash: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_hash(&commitment_hash);
    assert!(tx_context::sender(ctx) == job.worker, ENotWorker);
    assert!(option::is_none(&job.commitment_hash), EAlreadySubmitted);
    let submitted_at_ms = clock::timestamp_ms(clock);
    assert!(submitted_at_ms < job.deadline_ms, EDeadlinePassed);

    job.commitment_hash = option::some(commitment_hash);
    event::emit(WorkSubmitted {
        job_id: object::id(job),
        funder: job.funder,
        worker: job.worker,
        commitment_hash: *option::borrow(&job.commitment_hash),
        submitted_at_ms,
    });
}

/// Pay the fixed worker after a worker submission. Only the funder can settle.
/// Consuming the shared Job makes release and refund mutually exclusive.
public fun release(job: Job, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == job.funder, ENotBuyer);
    assert!(option::is_some(&job.commitment_hash), ENotSubmitted);

    let job_id = object::id(&job);
    let funder = job.funder;
    let worker = job.worker;
    let amount_mist = balance::value(&job.escrowed_sui);
    event::emit(JobReleased {
        job_id,
        funder,
        worker,
        amount_mist,
    });

    let Job {
        id,
        funder: _,
        worker: _,
        brief_hash: _,
        deadline_ms: _,
        commitment_hash: _,
        escrowed_sui,
    } = job;
    object::delete(id);
    transfer::public_transfer(coin::from_balance(escrowed_sui, ctx), worker);
}

/// Return escrow only to its funder, only after the deadline, and only if the
/// worker has not submitted. Consuming the shared Job prevents a second result.
public fun refund(job: Job, clock: &Clock, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == job.funder, ENotBuyer);
    assert!(option::is_none(&job.commitment_hash), EAlreadySubmittedForRefund);
    assert!(clock::timestamp_ms(clock) >= job.deadline_ms, ENotExpired);

    let job_id = object::id(&job);
    let funder = job.funder;
    let worker = job.worker;
    let amount_mist = balance::value(&job.escrowed_sui);
    event::emit(JobRefunded {
        job_id,
        funder,
        worker,
        amount_mist,
    });

    let Job {
        id,
        funder: _,
        worker: _,
        brief_hash: _,
        deadline_ms: _,
        commitment_hash: _,
        escrowed_sui,
    } = job;
    object::delete(id);
    transfer::public_transfer(coin::from_balance(escrowed_sui, ctx), funder);
}

fun assert_hash(hash: &vector<u8>) {
    assert!(vector::length(hash) == HASH_LENGTH, EInvalidHash);
}
