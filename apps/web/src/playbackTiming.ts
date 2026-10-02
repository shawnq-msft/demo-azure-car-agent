export class PlaybackTiming {
  private armed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  constructor(private observed: (time: number) => void) {}
  arm(): void { this.cancel(); this.armed = true; }
  cancel(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.armed = false;
  }
  scheduled(context: AudioContext, at: number): void {
    if (!this.armed || typeof context.getOutputTimestamp !== "function") return;
    this.armed = false;
    const generation = this.generation;
    const deadline = performance.now() + 35000;
    const check = () => {
      if (generation !== this.generation || context.state === "closed" || performance.now() > deadline) return;
      const stamp = context.getOutputTimestamp();
      if (context.state === "running" && stamp.contextTime !== undefined && stamp.performanceTime !== undefined &&
          stamp.contextTime >= at && stamp.performanceTime > 0) {
        this.observed(stamp.performanceTime - (stamp.contextTime - at) * 1000);
        this.timer = undefined;
      } else this.timer = setTimeout(check, 10);
    };
    this.timer = setTimeout(check, Math.max(0, (at - context.currentTime) * 1000));
  }
}
