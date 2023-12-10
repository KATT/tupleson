import {
	SerializedType,
	TsonNonce,
	TsonType,
	TsonTypeTesterCustom,
} from "../sync/syncTypes.js";
import { TsonGuard } from "../tsonAssert.js";
import {
	TsonAsyncUnfolderFactory,
	createTsonAsyncUnfoldFn,
} from "./createUnfoldAsyncFn.js";

export interface TsonAsyncMarshaller<
	TValue,
	TSerializedType extends SerializedType,
> {
	async: true;
	// deserialize: (
	// 	gen: AsyncGenerator<SerializedType, SerializedType, never>,
	// ) => AsyncIterable<TValue>;
	fold: (iter: AsyncIterable<TSerializedType>) => Promise<Awaited<TValue>>;
	key: string;
	unfold: ReturnType<
		typeof createTsonAsyncUnfoldFn<TsonAsyncUnfolderFactory<TValue>>
	>;
}

export type TsonAsyncType<
	/**
	 * The type of the value
	 */
	TValue,
	/**
	 * JSON-serializable value how it's stored after it's serialized
	 */
	TSerializedType extends SerializedType,
> = TsonTypeTesterCustom & TsonAsyncMarshaller<TValue, TSerializedType>;
export type TsonAsyncChildLabel = bigint | number | string;
export type TsonAsyncPath = [TsonNonce, ...TsonAsyncChildLabel[]];

export interface TsonAsyncOptions {
	/**
	 * A list of guards to apply to every value
	 */
	guards?: TsonGuard<any>[];
	/**
	 * The nonce function every time we start serializing a new object
	 * Should return a unique value every time it's called
	 * @default `${crypto.randomUUID} if available, otherwise a random string generated by Math.random`
	 */
	nonce?: () => bigint | number | string;
	/**
	 * The list of types to use
	 */
	types: (TsonAsyncType<any, any> | TsonType<any, any>)[];
}
