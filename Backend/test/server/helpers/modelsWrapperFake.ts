"use strict";

/**
 * @fileoverview Recording fake of oracle-mongo-wrapper for model unit tests.
 *
 * Use as:
 *   vi.mock("<path>/src/utils/oracle-mongo-wrapper", async () => (await import("<path>/test/server/helpers/modelsWrapperFake")).wrapperMock);
 * Every OracleCollection shares the vi.fn() terminals on `fake`, and the
 * cursor chain (project/sort/skip/limit) is recorded in `fake.chain` so a test
 * can assert the filters/binds a model hands to the wrapper.
 */

export const fake = {
    /** Constructor args of every OracleCollection built (table, db). */
    ctor: [] as unknown[][],
    /** Methods applied on the last find() cursor, in order. */
    chain: [] as Array<{ op: string; arg: unknown }>,
    findArgs: [] as unknown[],
    insertOne: vi.fn(),
    insertMany: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
    aggregate: vi.fn(),
    toArray: vi.fn(),
    next: vi.fn(),
    count: vi.fn(),
    withTransaction: vi.fn(),
    withReadOnlyTransaction: vi.fn(),
    txCtor: [] as unknown[][],
    db: { oracledb: { OUT_FORMAT_OBJECT: 4002, STRING: 2001 }, withConnection: vi.fn(), withTransaction: vi.fn() },
};

function makeCursor() {
    const cursor: Record<string, unknown> = {};
    for (const op of ["project", "sort", "skip", "limit", "forUpdate"]) {
        cursor[op] = (arg: unknown) => {
            fake.chain.push({ op, arg });
            return cursor;
        };
    }
    cursor.toArray = (...a: unknown[]) => fake.toArray(...a);
    cursor.next = (...a: unknown[]) => fake.next(...a);
    cursor.count = (...a: unknown[]) => fake.count(...a);
    return cursor;
}

class FakeCollection {
    constructor(...args: unknown[]) {
        fake.ctor.push(args);
    }
    insertOne = fake.insertOne;
    insertMany = fake.insertMany;
    updateOne = fake.updateOne;
    updateMany = fake.updateMany;
    deleteOne = fake.deleteOne;
    deleteMany = fake.deleteMany;
    findOne = fake.findOne;
    countDocuments = fake.countDocuments;
    aggregate = fake.aggregate;
    find(filter: unknown) {
        fake.chain.length = 0;
        fake.findArgs.push(filter);
        return makeCursor();
    }
}

class FakeTransaction {
    constructor(...args: unknown[]) {
        fake.txCtor.push(args);
    }
    withTransaction = fake.withTransaction;
    withReadOnlyTransaction = fake.withReadOnlyTransaction;
}

export const wrapperMock = {
    createDb: vi.fn(() => fake.db),
    OracleCollection: FakeCollection,
    Transaction: FakeTransaction,
};
