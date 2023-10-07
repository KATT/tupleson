import { expect, test, vi, vitest } from "vitest";

import {
	TsonType,
	createTsonAsync,
	createTsonParseAsync,
	tsonAsyncIterator,
	tsonBigint,
	tsonPromise,
} from "../index.js";
import { assert } from "../internals/assert.js";
import {
	createDeferred,
	createTestServer,
	wait as sleep,
	waitError,
} from "../internals/testUtils.js";
import { TsonSerialized } from "../sync/syncTypes.js";
import { TsonAsyncOptions } from "./asyncTypes.js";
import { mapIterable, readableStreamToAsyncIterable } from "./iterableUtils.js";

test("deserialize variable chunk length", async () => {
	const tson = createTsonAsync({
		nonce: () => "__tson",
		types: [tsonAsyncIterator, tsonPromise, tsonBigint],
	});
	{
		const iterable = (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 1));
			yield '[\n{"json":{"foo":"bar"},"nonce":"__tson"}';
			yield "\n,\n[\n]\n]";
		})();
		const result = await tson.parse(iterable);
		expect(result).toEqual({ foo: "bar" });
	}

	{
		const iterable = (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 1));
			yield '[\n{"json":{"foo":"bar"},"nonce":"__tson"}\n,\n[\n]\n]';
		})();
		const result = await tson.parse(iterable);
		expect(result).toEqual({ foo: "bar" });
	}

	{
		const iterable = (async function* () {
			await new Promise((resolve) => setTimeout(resolve, 1));
			yield '[\n{"json"';
			yield ':{"foo":"b';
			yield 'ar"},"nonce":"__tson"}\n,\n';
			yield "[\n]\n";
			yield "]";
		})();
		const result = await tson.parse(iterable);
		expect(result).toEqual({ foo: "bar" });
	}
});

test("deserialize async iterable", async () => {
	const tson = createTsonAsync({
		nonce: () => "__tson",
		types: [tsonAsyncIterator, tsonPromise, tsonBigint],
	});

	{
		// plain obj
		const obj = {
			foo: "bar",
		};

		const strIterable = tson.stringify(obj);

		const result = await tson.parse(strIterable);

		expect(result).toEqual(obj);
	}

	{
		// promise
		const obj = {
			foo: Promise.resolve("bar"),
		};

		const strIterable = tson.stringify(obj);

		const result = await tson.parse(strIterable);

		expect(await result.foo).toEqual("bar");
	}
});

test("stringify async iterable + promise", async () => {
	const onErr = vi.fn();
	const tson = createTsonAsync({
		nonce: () => "__tson",
		onStreamError: onErr,
		types: [tsonAsyncIterator, tsonPromise, tsonBigint],
	});

	async function* iterable() {
		await new Promise((resolve) => setTimeout(resolve, 1));
		yield 1n;
		await new Promise((resolve) => setTimeout(resolve, 1));
		yield 2n;
		yield 3n;

		await new Promise((resolve) => setTimeout(resolve, 2));
		yield 4n;
		yield 5n;
	}

	const input = {
		foo: "bar",
		iterable: iterable(),
		promise: Promise.resolve(42),
	};

	const strIterable = tson.stringify(input);

	const output = await tson.parse(strIterable);

	expect(output.foo).toEqual("bar");

	expect(await output.promise).toEqual(42);

	const result = [];

	for await (const value of output.iterable) {
		result.push(value);
	}

	expect(result).toEqual([1n, 2n, 3n, 4n, 5n]);
});

test("e2e: stringify async iterable and promise over the network", async () => {
	function createMockObj() {
		async function* generator() {
			for (const number of [1n, 2n, 3n, 4n, 5n]) {
				await new Promise((resolve) => setTimeout(resolve, 1));
				yield number;
			}
		}

		return {
			foo: "bar",
			iterable: generator(),
			promise: Promise.resolve(42),
			rejectedPromise: Promise.reject(new Error("rejected promise")),
		};
	}

	type MockObj = ReturnType<typeof createMockObj>;

	// ------------- server -------------------
	const opts: TsonAsyncOptions = {
		types: [tsonPromise, tsonAsyncIterator, tsonBigint],
	};

	const server = await createTestServer({
		handleRequest: async (_req, res) => {
			const tson = createTsonAsync(opts);

			const obj = createMockObj();
			const strIterarable = tson.stringify(obj, 4);

			for await (const value of strIterarable) {
				res.write(value);
			}

			res.end();
		},
	});

	// ------------- client -------------------
	const tson = createTsonAsync(opts);

	// do a streamed fetch request
	const response = await fetch(server.url);

	assert(response.body);

	const textDecoder = new TextDecoder();

	// convert the response body to an async iterable
	const stringIterator = mapIterable(
		readableStreamToAsyncIterable(response.body),
		(v) => textDecoder.decode(v),
	);

	const parsed = await tson.parse<MockObj>(stringIterator);

	expect(parsed.foo).toEqual("bar");

	const results = [];

	for await (const value of parsed.iterable) {
		results.push(value);
	}

	expect(results).toEqual([1n, 2n, 3n, 4n, 5n]);

	expect(await parsed.promise).toEqual(42);

	await expect(
		parsed.rejectedPromise,
	).rejects.toThrowErrorMatchingInlineSnapshot('"Promise rejected"');

	server.close();
});

class CustomError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomError";
	}
}

const tsonCustomError: TsonType<CustomError, { message: string }> = {
	deserialize: (value) => new Error(value.message),
	key: "CustomError",
	serialize: (value) => ({
		message: value.message,
	}),
	test: (value) => value instanceof CustomError,
};

test("iterator error", async () => {
	function createMockObj() {
		const deferred = createDeferred<string>();

		async function* generator() {
			for (let index = 0; index < 3; index++) {
				yield `item: ${index}`;

				await new Promise((resolve) => setTimeout(resolve, 1));
			}

			// resolve the deferred after crash
			setTimeout(() => {
				deferred.resolve("deferred resolved");
			}, 10);

			throw new CustomError("server iterator error");
		}

		return {
			deferred: deferred.promise,
			iterable: generator(),
			promise: Promise.resolve(42),
		};
	}

	type MockObj = ReturnType<typeof createMockObj>;

	// ------------- server -------------------
	const opts: TsonAsyncOptions = {
		types: [tsonPromise, tsonAsyncIterator, tsonCustomError],
	};

	const server = await createTestServer({
		handleRequest: async (_req, res) => {
			const tson = createTsonAsync(opts);

			const obj = createMockObj();
			const strIterarable = tson.stringify(obj, 4);

			for await (const value of strIterarable) {
				res.write(value);
			}

			res.end();
		},
	});

	// ------------- client -------------------
	const tson = createTsonAsync(opts);

	// do a streamed fetch request
	const response = await fetch(server.url);

	assert(response.body);

	const textDecoder = new TextDecoder();
	const stringIterator = mapIterable(
		readableStreamToAsyncIterable(response.body),
		(v) => textDecoder.decode(v),
	);

	const parsed = await tson.parse<MockObj>(stringIterator);
	expect(await parsed.promise).toEqual(42);

	const results = [];
	let iteratorError: Error | null = null;
	try {
		for await (const value of parsed.iterable) {
			results.push(value);
		}
	} catch (err) {
		iteratorError = err as Error;
	} finally {
		server.close();
	}

	expect(iteratorError).toMatchInlineSnapshot("[Error: server iterator error]");

	expect(await parsed.deferred).toEqual("deferred resolved");
	expect(await parsed.promise).toEqual(42);
	expect(results).toMatchInlineSnapshot(`
		[
		  "item: 0",
		  "item: 1",
		  "item: 2",
		]
	`);
});

test("values missing when stream ends", async () => {
	async function* generator() {
		await Promise.resolve();

		yield "[" + "\n";

		const obj = {
			json: {
				iterable: ["AsyncIterable", 1, "__tson"],
				promise: ["Promise", 0, "__tson"],
			},
			nonce: "__tson",
		} as TsonSerialized<any>;
		yield JSON.stringify(obj) + "\n";

		await sleep(1);

		yield "  ," + "\n";
		yield "  [" + "\n";
		// <values>
		// - promise is never resolved

		// - iterator is never closed
		yield `    [1, [0, "value 1"]]`;
		yield `    [1, [0, "value 2"]]`;
		// yield `    [1, [2]]`; // iterator done

		// </values>
		// yield "  ]" + "\n";
		// yield "]";
	}

	const opts = {
		onStreamError: vitest.fn(),
		types: [tsonPromise, tsonAsyncIterator],
	} satisfies TsonAsyncOptions;

	const parse = createTsonParseAsync(opts);

	const result = await parse<{
		iterable: AsyncIterable<string>;
		promise: Promise<unknown>;
	}>(generator());

	{
		// iterator should error
		const results = [];

		let err: Error | null = null;
		try {
			for await (const value of result.iterable) {
				results.push(value);
			}
		} catch (cause) {
			err = cause as Error;
		}

		assert(err);

		expect(err.message).toMatchInlineSnapshot(
			'"Stream interrupted: Stream ended unexpectedly"',
		);
	}

	{
		// promise was never resolved and should error
		const err = await waitError(result.promise);

		expect(err).toMatchInlineSnapshot(
			"[TsonError: Stream interrupted: Stream ended unexpectedly]",
		);
	}

	expect(opts.onStreamError).toHaveBeenCalledTimes(1);
	expect(opts.onStreamError.mock.calls).toMatchInlineSnapshot(`
		[
		  [
		    [TsonError: Stream interrupted: Stream ended unexpectedly],
		  ],
		]
	`);
});
