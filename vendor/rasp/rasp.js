/* @ts-self-types="./rasp.d.ts" */

/**
 * A decoded clip: interleaved `f32` samples at 48 kHz.
 */
export class Decoded {
    static __wrap(ptr) {
        const obj = Object.create(Decoded.prototype);
        obj.__wbg_ptr = ptr;
        DecodedFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DecodedFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_decoded_free(ptr, 0);
    }
    /**
     * Number of interleaved channels (1 = mono, 2 = stereo).
     * @returns {number}
     */
    channels() {
        const ret = wasm.decoded_channels(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of **frames** (samples per channel). Use this as `AudioBuffer`'s
     * length; do not use the interleaved sample count.
     * @returns {number}
     */
    length() {
        const ret = wasm.decoded_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Sample rate of [`samples`](Self::samples), in Hz. Always 48000 today.
     * @returns {number}
     */
    sample_rate() {
        const ret = wasm.decoded_sample_rate(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Interleaved samples, `length() * channels()` long, as a `Float32Array`
     * **copy**. The copy stays valid after [`free`](Self::free).
     * @returns {Float32Array}
     */
    samples() {
        const ret = wasm.decoded_samples(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) Decoded.prototype[Symbol.dispose] = Decoded.prototype.free;

/**
 * Decode a WebM/Opus (`.weba`) clip.
 *
 * `bytes` must be the whole file. See the crate docs for the error surface.
 * @param {Uint8Array} bytes
 * @returns {Decoded}
 */
export function decode(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Decoded.__wrap(ret[0]);
}

/**
 * Resolve a game seed to its rendered voice description (V-02).
 *
 * Pure: no decoding, no DSP, no allocation beyond the returned object.
 *
 * The result is `{ seed, voiceId, archetype, schema, pitchSt, formantRatio,
 * tiltDbPerOct }`:
 *
 * * `seed` — the exact string passed in;
 * * `voiceId` — one of the 54 ids in `web/registry.json`;
 * * `archetype` — one of the twelve V-01 archetype ids (`masc-deep`,
 *   `fem-airy`, `child`, …);
 * * `schema` — [`variant_schema`] at the time of the call;
 * * `pitchSt` / `formantRatio` / `tiltDbPerOct` — the **requested** point, on
 *   the D24 quantisation grid. These are what the game shows and stores. The
 *   renderer may scale them by the D22 headroom weight for a particular line;
 *   that effective point is not part of the identity.
 * @param {string} seed
 * @returns {any}
 */
export function describe(seed) {
    const ptr0 = passStringToWasm0(seed, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.describe(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * The operating point a [`render_params`] call would actually use for this
 * clip, after the D22 headroom mapping.
 *
 * Returns `{ pitchSt, formantRatio, tiltDbPerOct, headroomWeight }`, where
 * `headroomWeight` is the D22 weight `w ∈ [0, 1]` and the three knobs are the
 * **effective** values (`nominal × w`, with the formant ratio scaled in
 * octaves). The nominal knobs stay the caller's: this call does not change
 * them.
 *
 * The measurement and the mapping are the ones the renderer itself uses:
 * [`median_f0_hz`] on the decoded clip (the same `F0Tracker` as
 * `NaturalRenderer::process_into_reported`) followed by
 * [`HeadroomReport::new`] in [`HeadroomMode::On`]. As in the renderer, a
 * nominal pitch of exactly zero has no direction to exhaust, so the result is
 * a pass-through with `w = 1`; a clip with no voiced frames also falls back to
 * `w = 1` rather than guessing. Reading this does **not** render the clip, so
 * a UI can update its "effective" line while a slider moves.
 * @param {Uint8Array} weba
 * @param {number} pitch_st
 * @param {number} formant_ratio
 * @param {number} tilt_db_per_oct
 * @returns {any}
 */
export function effective_params(weba, pitch_st, formant_ratio, tilt_db_per_oct) {
    const ptr0 = passArray8ToWasm0(weba, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.effective_params(ptr0, len0, pitch_st, formant_ratio, tilt_db_per_oct);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Decode a `.weba` clip, derive its voice from `seed`, and render one line.
 *
 * Returns mono `f32` samples at 48 kHz. The length equals the decoded clip's
 * frame count exactly (the natural chain neither trims nor pads), so the
 * output is sample-aligned with the source for A/B playback. A stereo input is
 * averaged to mono; the corpus is mono.
 *
 * The chain is [`rasp_dsp::NaturalRenderer::d2`]: pitch/formant/tilt with D22
 * headroom scaling, then the P-08 RMS match and true-peak limiter. The caller
 * owns the returned array; see the crate docs.
 * @param {Uint8Array} weba
 * @param {string} seed
 * @returns {Float32Array}
 */
export function render(weba, seed) {
    const ptr0 = passArray8ToWasm0(weba, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(seed, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.render(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * Decode a `.weba` clip and render it at explicit natural-mode knobs.
 *
 * This is the manual-knob counterpart of [`render`]: same decoder, same
 * [`rasp_dsp::NaturalRenderer`] chain (D22 headroom scaling, then the P-08 RMS
 * match and true-peak limiter), same 48 kHz mono output and the same
 * sample-aligned length contract. Out-of-range or non-finite knobs are
 * **sanitised** by [`NaturalParams`] rather than rejected: pitch is clamped to
 * −12…+12 st, formant to 0.75…1.33 and tilt to −6…+6 dB/oct; a non-finite
 * value becomes that axis's neutral value. This is what the demo's sliders
 * rely on, so a typed `RenderError` here means the DSP genuinely failed, not
 * that a caller typed `13`.
 *
 * The caller owns the returned array; see the crate docs.
 * @param {Uint8Array} weba
 * @param {number} pitch_st
 * @param {number} formant_ratio
 * @param {number} tilt_db_per_oct
 * @returns {Float32Array}
 */
export function render_params(weba, pitch_st, formant_ratio, tilt_db_per_oct) {
    const ptr0 = passArray8ToWasm0(weba, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.render_params(ptr0, len0, pitch_st, formant_ratio, tilt_db_per_oct);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * The derivation schema this build implements (D24).
 *
 * Mix this value into any cache key. A different number means a different
 * `seed → voice + params` contract.
 * @returns {number}
 */
export function variant_schema() {
    const ret = wasm.variant_schema();
    return ret;
}

/**
 * Version string for diagnostics. Contains the crate version and nothing that
 * depends on the registry or the build environment.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_343a093a3c2ffb4e: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_name_2c630595dc90a7aa: function(arg0, arg1, arg2) {
            arg0.name = getStringFromWasm0(arg1, arg2);
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./rasp_bg.js": import0,
    };
}

const DecodedFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_decoded_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('rasp_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
