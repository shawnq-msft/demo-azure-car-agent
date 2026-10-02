class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
    this.remaining = this.ratio;
    this.sum = 0;
    this.buffer = new Int16Array(2400);
    this.index = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      let weight = 1;
      while (weight > 0.000001) {
        const take = Math.min(weight, this.remaining);
        this.sum += sample * take;
        this.remaining -= take;
        weight -= take;
        if (this.remaining < 0.000001) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.buffer[this.index++] = Math.round(value < 0 ? value * 32768 : value * 32767);
          this.sum = 0;
          this.remaining = this.ratio;
          if (this.index === this.buffer.length) {
            this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
            this.buffer = new Int16Array(2400);
            this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
