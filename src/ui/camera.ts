// In-app viewfinder: the rear camera streams into a <video>, and the shutter
// grabs the current frame. Skips the round trip through the phone's camera
// app, which was most of the time per stack.

export class Camera {
  private stream: MediaStream | null = null;
  private starting: Promise<void> | null = null;
  /** Bumped by stop(), so a start that finishes after it knows to give up. */
  private generation = 0;

  constructor(private video: HTMLVideoElement) {}

  /** getUserMedia needs a secure context (HTTPS or localhost). */
  static supported(): boolean {
    return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  }

  get running(): boolean {
    return this.stream !== null;
  }

  /**
   * Start streaming. Calls while a start is pending share it. If stop() runs
   * before it finishes, it resolves with the camera off: check `running`.
   */
  start(): Promise<void> {
    if (this.stream) return Promise.resolve();
    if (this.starting) return this.starting;
    const p = this.open().finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  private async open(): Promise<void> {
    const gen = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Ask for as many pixels as the camera will stream; thinner items need them.
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 4096 } },
    });
    if (gen !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (err) {
      if (gen !== this.generation) return; // stopped meanwhile; play() rejects then
      this.stop();
      throw err;
    }
  }

  stop(): void {
    this.generation++;
    this.starting = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** The current frame at the stream's full resolution, oriented as displayed. */
  async grab(): Promise<ImageBitmap> {
    if (!this.stream || this.video.videoWidth === 0) throw new Error('camera not ready');
    return createImageBitmap(this.video);
  }

  private get track(): MediaStreamTrack | undefined {
    return this.stream?.getVideoTracks()[0];
  }

  get hasTorch(): boolean {
    const caps = this.track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    return !!caps?.torch;
  }

  async setTorch(on: boolean): Promise<void> {
    await this.track?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
  }
}
