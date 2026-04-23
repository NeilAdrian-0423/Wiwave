// Voice processor: optional RNNoise + noise gate.
// RNNoise wants 48 kHz, 480-sample frames. We buffer to frames, process, then drain.

const FRAME = 480;

class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.rnnoiseEnabled = true;
    this.gateEnabled = true;
    this.thresholdDb = -50;
    this.gain = 0;

    this.inBuf = new Float32Array(FRAME * 4);
    this.inLen = 0;
    this.outBuf = new Float32Array(FRAME * 4);
    this.outLen = 0;

    this.rnnReady = false;
    this.rnnAvailable = sampleRate === 48000 && typeof createRNNWasmModuleSync === 'function';

    if (this.rnnAvailable) {
      try {
        const Module = createRNNWasmModuleSync();
        Module.ready.then(() => {
          this.M = Module;
          this.state = Module._rnnoise_create(0);
          this.inPtr = Module._malloc(FRAME * 4);
          this.outPtr = Module._malloc(FRAME * 4);
          this.rnnReady = true;
          this.port.postMessage({ type: 'ready', rnnoise: true });
        }).catch((e) => {
          this.rnnAvailable = false;
          this.port.postMessage({ type: 'ready', rnnoise: false, reason: 'init-failed: ' + e });
        });
      } catch (e) {
        this.rnnAvailable = false;
        this.port.postMessage({ type: 'ready', rnnoise: false, reason: 'init-threw: ' + e });
      }
    } else {
      this.port.postMessage({
        type: 'ready',
        rnnoise: false,
        reason: sampleRate !== 48000 ? `sample-rate-${sampleRate}` : 'no-wasm',
      });
    }

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'threshold') this.thresholdDb = d.value;
      if (d.type === 'rnnoise') this.rnnoiseEnabled = d.value;
      if (d.type === 'gate') this.gateEnabled = d.value;
    };

    this.meterCounter = 0;
  }

  processFrame(frame) {
    if (this.rnnoiseEnabled && this.rnnReady) {
      const heap = this.M.HEAPF32;
      const inOff = this.inPtr >> 2;
      const outOff = this.outPtr >> 2;
      for (let i = 0; i < FRAME; i++) heap[inOff + i] = frame[i] * 32768;
      this.M._rnnoise_process_frame(this.state, this.outPtr, this.inPtr);
      for (let i = 0; i < FRAME; i++) frame[i] = heap[outOff + i] / 32768;
    }

    let sum = 0;
    for (let i = 0; i < FRAME; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / FRAME);
    const db = 20 * Math.log10(rms + 1e-9);

    if (this.gateEnabled) {
      const target = db > this.thresholdDb ? 1 : 0;
      // 10ms blocks at 48k: ~attack 5ms, release 150ms
      const alpha = target > this.gain ? 0.865 : 0.064;
      this.gain += (target - this.gain) * alpha;
      for (let i = 0; i < FRAME; i++) frame[i] *= this.gain;
    } else {
      this.gain = 1;
    }

    // Meter update at ~20 Hz
    if (++this.meterCounter >= 5) {
      this.meterCounter = 0;
      this.port.postMessage({ type: 'meter', db, gain: this.gain });
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (input && input.length) {
      if (this.inLen + input.length > this.inBuf.length) {
        // shouldn't happen, but be safe
        this.inLen = 0;
      }
      this.inBuf.set(input, this.inLen);
      this.inLen += input.length;
    }

    while (this.inLen >= FRAME) {
      const frame = this.inBuf.subarray(0, FRAME).slice();
      this.processFrame(frame);

      if (this.outLen + FRAME <= this.outBuf.length) {
        this.outBuf.set(frame, this.outLen);
        this.outLen += FRAME;
      }

      this.inBuf.copyWithin(0, FRAME, this.inLen);
      this.inLen -= FRAME;
    }

    const n = output.length;
    if (this.outLen >= n) {
      output.set(this.outBuf.subarray(0, n));
      this.outBuf.copyWithin(0, n, this.outLen);
      this.outLen -= n;
    } else {
      output.fill(0);
    }

    return true;
  }
}

registerProcessor('voice-processor', VoiceProcessor);
