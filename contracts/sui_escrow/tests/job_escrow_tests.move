#[test_only]
module ask2human_escrow::job_escrow_tests;

use std::option::{Self, Option};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::object::ID;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};
use ask2human_escrow::job_escrow::{Self, Job};

const BUYER: address = @0xB0;
const WORKER: address = @0xA0;
const OTHER: address = @0xC0;
const AMOUNT_MIST: u64 = 42_000_000;
const DEADLINE_MS: u64 = 100;

#[test]
fun release_pays_fixed_worker_after_submission() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    scenario.next_tx(WORKER);
    let mut job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::submit(&mut job, sample_hash(), &clock, ts::ctx(&mut scenario));
    ts::return_shared(job);
    ts::return_shared(clock);

    scenario.next_tx(BUYER);
    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    job_escrow::release(job, ts::ctx(&mut scenario));

    scenario.next_tx(WORKER);
    let payout: Coin<SUI> = ts::take_from_sender(&scenario);
    assert!(coin::value(&payout) == AMOUNT_MIST, 0);
    ts::return_to_sender(&scenario, payout);
    scenario.end();
}

#[test]
#[expected_failure]
fun release_before_submission_aborts() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    job_escrow::release(job, ts::ctx(&mut scenario));
    scenario.end();
}

#[test]
#[expected_failure]
fun only_funder_can_release_after_submission() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    scenario.next_tx(WORKER);
    let mut job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::submit(&mut job, sample_hash(), &clock, ts::ctx(&mut scenario));
    ts::return_shared(job);
    ts::return_shared(clock);

    scenario.next_tx(OTHER);
    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    job_escrow::release(job, ts::ctx(&mut scenario));
    scenario.end();
}

#[test]
#[expected_failure]
fun only_fixed_worker_can_submit() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    scenario.next_tx(OTHER);
    let mut job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::submit(&mut job, sample_hash(), &clock, ts::ctx(&mut scenario));
    ts::return_shared(job);
    ts::return_shared(clock);
    scenario.end();
}

#[test]
#[expected_failure]
fun refund_before_deadline_aborts() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::refund(job, &clock, ts::ctx(&mut scenario));
    ts::return_shared(clock);
    scenario.end();
}

#[test]
fun expired_unsubmitted_job_refunds_fixed_buyer() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    let mut clock: Clock = ts::take_shared(&scenario);
    clock::set_for_testing(&mut clock, DEADLINE_MS);
    ts::return_shared(clock);

    scenario.next_tx(BUYER);
    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::refund(job, &clock, ts::ctx(&mut scenario));
    ts::return_shared(clock);

    scenario.next_tx(BUYER);
    let payout: Coin<SUI> = ts::take_from_sender(&scenario);
    assert!(coin::value(&payout) == AMOUNT_MIST, 1);
    ts::return_to_sender(&scenario, payout);
    scenario.end();
}

#[test]
#[expected_failure]
fun only_funder_can_refund_expired_job() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    let mut clock: Clock = ts::take_shared(&scenario);
    clock::set_for_testing(&mut clock, DEADLINE_MS);
    ts::return_shared(clock);

    scenario.next_tx(OTHER);
    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::refund(job, &clock, ts::ctx(&mut scenario));
    ts::return_shared(clock);
    scenario.end();
}

#[test]
#[expected_failure]
fun submitted_job_cannot_be_refunded() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    scenario.next_tx(WORKER);
    let mut job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::submit(&mut job, sample_hash(), &clock, ts::ctx(&mut scenario));
    ts::return_shared(job);
    ts::return_shared(clock);

    scenario.next_tx(BUYER);
    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    let mut clock: Clock = ts::take_shared(&scenario);
    clock::set_for_testing(&mut clock, DEADLINE_MS);
    job_escrow::refund(job, &clock, ts::ctx(&mut scenario));
    ts::return_shared(clock);
    scenario.end();
}

#[test]
#[expected_failure]
fun released_job_cannot_be_settled_again() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    scenario.next_tx(WORKER);
    let mut job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::submit(&mut job, sample_hash(), &clock, ts::ctx(&mut scenario));
    ts::return_shared(job);
    ts::return_shared(clock);

    scenario.next_tx(BUYER);
    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    job_escrow::release(job, ts::ctx(&mut scenario));

    scenario.next_tx(BUYER);
    let job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::refund(job, &clock, ts::ctx(&mut scenario));
    ts::return_shared(clock);
    scenario.end();
}

#[test]
#[expected_failure]
fun submission_at_deadline_is_rejected() {
    let mut scenario = start_scenario();
    let job_id = fund_job(&mut scenario, DEADLINE_MS);

    let mut clock: Clock = ts::take_shared(&scenario);
    clock::set_for_testing(&mut clock, DEADLINE_MS);
    ts::return_shared(clock);

    scenario.next_tx(WORKER);
    let mut job: Job = ts::take_shared_by_id(&scenario, job_id);
    let clock: Clock = ts::take_shared(&scenario);
    job_escrow::submit(&mut job, sample_hash(), &clock, ts::ctx(&mut scenario));
    ts::return_shared(job);
    ts::return_shared(clock);
    scenario.end();
}

fun start_scenario(): Scenario {
    let mut scenario = ts::begin(BUYER);
    clock::share_for_testing(clock::create_for_testing(ts::ctx(&mut scenario)));
    scenario.next_tx(BUYER);
    scenario
}

fun fund_job(scenario: &mut Scenario, deadline_ms: u64): ID {
    let payment = coin::mint_for_testing<SUI>(AMOUNT_MIST, ts::ctx(scenario));
    let clock: Clock = ts::take_shared(scenario);
    job_escrow::create_and_fund(
        payment,
        WORKER,
        sample_hash(),
        deadline_ms,
        &clock,
        ts::ctx(scenario),
    );
    ts::return_shared(clock);

    scenario.next_tx(BUYER);
    option::destroy_some(ts::most_recent_id_shared<Job>())
}

fun sample_hash(): vector<u8> {
    let mut hash: vector<u8> = vector[];
    let mut index = 0u64;
    while (index < 32) {
        vector::push_back(&mut hash, index as u8);
        index = index + 1;
    };
    hash
}
