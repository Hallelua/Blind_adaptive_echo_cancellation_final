import * as Comlink from 'comlink';

class AudioProcessor {
  // Enhanced settings for better echo cancellation
  private readonly kalmanGain: number = 0.05;
  private readonly nlmsStepSize: number = 0.8; // Increased for stronger echo suppression
  private readonly filterLength: number = 1024; // Increased for better echo cancellation
  private echoDelay: number = 100;
  private readonly echoIntensity: number = 50;
  private readonly overlapFactor: number = 4; // Added overlap processing for better results

  private metrics = {
    erle: 0,
    snr: 0,
    rea: 0,
    latency: 0,
    convergence: 0
  };

  setParameters(params: { echoDelay?: number }) {
    if (params.echoDelay !== undefined) this.echoDelay = params.echoDelay;
  }

  getMetrics() {
    return this.metrics;
  }

  private calculateERLE(original: Float32Array, processed: Float32Array): number {
    let sumOriginalSquared = 0;
    let sumProcessedSquared = 0;
    
    const chunkSize = 256;
    for (let i = 0; i < original.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, original.length);
      for (let j = i; j < end; j++) {
        const origVal = original[j];
        const procVal = processed[j];
        sumOriginalSquared += origVal * origVal;
        sumProcessedSquared += procVal * procVal;
      }
    }
    
    // Enhanced ERLE calculation with noise floor consideration
    const noiseFloor = 1e-12;
    return 10 * Math.log10((sumOriginalSquared + noiseFloor) / (sumProcessedSquared + noiseFloor));
  }

  private calculateSNR(signal: Float32Array): number {
    const frameSize = 128;
    let signalPower = 0;
    let noisePower = 0;
    
    for (let i = 0; i < signal.length; i += frameSize) {
      let framePower = 0;
      const end = Math.min(i + frameSize, signal.length);
      
      for (let j = i; j < end; j++) {
        framePower += signal[j] * signal[j];
      }
      
      if (framePower > 0.005) {
        signalPower += framePower;
      } else {
        noisePower += framePower;
      }
    }
    
    return 10 * Math.log10((signalPower + 1e-10) / (noisePower + 1e-10));
  }

  private calculateREA(original: Float32Array, processed: Float32Array): number {
    let sumProcessedSquared = 0;
    let sumOriginalSquared = 0;
    
    const chunkSize = 256;
    for (let i = 0; i < original.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, original.length);
      for (let j = i; j < end; j++) {
        const origVal = original[j];
        const procVal = processed[j];
        sumProcessedSquared += procVal * procVal;
        sumOriginalSquared += origVal * origVal;
      }
    }
    
    // Enhanced REA calculation
    const noiseFloor = 1e-12;
    return 20 * Math.log10((sumOriginalSquared + noiseFloor) / (sumProcessedSquared + noiseFloor));
  }

  async addEcho(audioData: Float32Array): Promise<Float32Array> {
    const startTime = performance.now();
    const delayInSamples = Math.floor(this.echoDelay * 44.1);
    const intensity = this.echoIntensity / 100;
    
    const output = new Float32Array(audioData.length);
    const chunkSize = 256;
    
    for (let i = 0; i < audioData.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, audioData.length);
      for (let j = i; j < end; j++) {
        output[j] = audioData[j];
        if (j >= delayInSamples) {
          output[j] += audioData[j - delayInSamples] * intensity;
        }
      }
    }

    this.metrics.latency = performance.now() - startTime;
    return output;
  }

  async removeEcho(audioData: Float32Array): Promise<Float32Array> {
    const startTime = performance.now();
    
    // Apply multi-stage processing for better echo cancellation
    const preProcessed = await this.applyPreProcessing(audioData);
    const processed = await this.applyNLMSFilter(preProcessed);
    const postProcessed = await this.applyPostProcessing(processed);
    
    const [erle, rea] = await Promise.all([
      this.calculateERLE(audioData, postProcessed),
      this.calculateREA(audioData, postProcessed)
    ]);
    
    this.metrics.erle = erle;
    this.metrics.rea = rea;
    this.metrics.latency = performance.now() - startTime;
    
    return postProcessed;
  }

  private async applyPreProcessing(input: Float32Array): Promise<Float32Array> {
    // Apply pre-emphasis filter
    const output = new Float32Array(input.length);
    const alpha = 0.95;
    
    output[0] = input[0];
    for (let i = 1; i < input.length; i++) {
      output[i] = input[i] - alpha * input[i - 1];
    }
    
    return output;
  }

  private async applyPostProcessing(input: Float32Array): Promise<Float32Array> {
    // Apply de-emphasis filter
    const output = new Float32Array(input.length);
    const alpha = 0.95;
    
    output[0] = input[0];
    for (let i = 1; i < input.length; i++) {
      output[i] = input[i] + alpha * output[i - 1];
    }
    
    return output;
  }

  async processNoiseAndEcho(audioData: Float32Array): Promise<Float32Array> {
    const startTime = performance.now();
    
    const preProcessed = await this.applyPreProcessing(audioData);
    const denoised = await this.applyKalmanFilter(preProcessed);
    const processed = await this.applyNLMSFilter(denoised);
    const postProcessed = await this.applyPostProcessing(processed);
    
    const [snr, erle, rea] = await Promise.all([
      this.calculateSNR(audioData),
      this.calculateERLE(audioData, postProcessed),
      this.calculateREA(audioData, postProcessed)
    ]);
    
    this.metrics.snr = snr;
    this.metrics.erle = erle;
    this.metrics.rea = rea;
    this.metrics.latency = performance.now() - startTime;
    
    return postProcessed;
  }

  private applyKalmanFilter(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    let estimate = 0;
    let errorCovariance = 0.1;
    const processNoise = 0.00001;
    
    const chunkSize = 256;
    
    for (let i = 0; i < input.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, input.length);
      for (let j = i; j < end; j++) {
        const prediction = estimate;
        errorCovariance += processNoise;

        const kalmanGain = errorCovariance / (errorCovariance + this.kalmanGain);
        estimate = prediction + kalmanGain * (input[j] - prediction);
        errorCovariance = (1 - kalmanGain) * errorCovariance;

        output[j] = estimate;
      }
    }

    return output;
  }

  private applyNLMSFilter(input: Float32Array): Float32Array {
    const startTime = performance.now();
    const output = new Float32Array(input.length);
    const weights = new Float32Array(this.filterLength).fill(0);
    const buffer = new Float32Array(this.filterLength).fill(0);
    let converged = false;
    
    const convergenceThreshold = 0.0005; // Stricter convergence threshold
    const stabilityFactor = 1e-8; // Improved stability factor
    const chunkSize = 128;
    
    // Overlap-save processing for better echo cancellation
    const overlapSize = Math.floor(chunkSize / this.overlapFactor);
    const processingBuffer = new Float32Array(chunkSize + this.filterLength);
    
    for (let i = 0; i < input.length; i += chunkSize - overlapSize) {
      const end = Math.min(i + chunkSize, input.length);
      
      // Fill processing buffer
      processingBuffer.fill(0);
      for (let j = 0; j < end - i; j++) {
        processingBuffer[j] = input[i + j];
      }
      
      // Process chunk with overlap
      for (let j = 0; j < chunkSize; j++) {
        buffer.copyWithin(1, 0);
        buffer[0] = processingBuffer[j];

        let y = 0;
        for (let k = 0; k < this.filterLength; k++) {
          y += weights[k] * buffer[k];
        }
        
        const error = processingBuffer[j] - y;
        output[i + j] = y;

        let powerSpectrum = 0;
        for (let k = 0; k < this.filterLength; k++) {
          powerSpectrum += buffer[k] * buffer[k];
        }
        
        const normalizedStepSize = this.nlmsStepSize / (powerSpectrum + stabilityFactor);
        
        for (let k = 0; k < this.filterLength; k++) {
          weights[k] += normalizedStepSize * error * buffer[k];
        }

        if (!converged && Math.abs(error) < convergenceThreshold) {
          converged = true;
          this.metrics.convergence = performance.now() - startTime;
        }
      }
    }

    if (!converged) {
      this.metrics.convergence = performance.now() - startTime;
    }

    return output;
  }
}

Comlink.expose(AudioProcessor);