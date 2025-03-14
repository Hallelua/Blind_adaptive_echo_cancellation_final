import React, { useRef, useState, useEffect } from 'react';
import { AudioWaveform as Waveform, Settings, Volume2, Mic, Upload, Play } from 'lucide-react';
import WaveSurfer from 'wavesurfer.js';
import * as Comlink from 'comlink';
import { useAudioRecorder } from '../hooks/useAudioRecorder';

interface AudioProcessorProps {
  mode: 'echo' | 'noise-echo';
}

interface PerformanceMetrics {
  erle: number;
  snr: number;
  rea: number;
  latency: number;
  convergence: number;
}

export const AudioProcessor: React.FC<AudioProcessorProps> = ({ mode }) => {
  const { isRecording, startRecording, stopRecording } = useAudioRecorder();
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [echoedUrl, setEchoedUrl] = useState<string | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [processingStage, setProcessingStage] = useState<'input' | 'echo' | 'final'>('input');
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurfer = useRef<WaveSurfer | null>(null);
  const audioWorker = useRef<any>(null);

  // Only echo delay is configurable now
  const [echoDelay, setEchoDelay] = useState(100);

  useEffect(() => {
    if (waveformRef.current) {
      wavesurfer.current = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: '#4F46E5',
        progressColor: '#818CF8',
        cursorColor: '#4F46E5',
        height: 100,
      });
    }

    const worker = new Worker(new URL('../lib/audioWorker.ts', import.meta.url), {
      type: 'module',
    });
    audioWorker.current = Comlink.wrap(worker);

    return () => {
      wavesurfer.current?.destroy();
      worker.terminate();
    };
  }, []);

  const handleRecordToggle = async () => {
    if (isRecording) {
      const audioBlob = await stopRecording();
      const url = URL.createObjectURL(audioBlob);
      setAudioUrl(url);
      setProcessingStage('input');
      wavesurfer.current?.load(url);
    } else {
      await startRecording();
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setAudioUrl(url);
      setProcessingStage('input');
      wavesurfer.current?.load(url);
    }
  };

  const handleAddEcho = async () => {
    if (!audioUrl || !audioWorker.current) return;

    setIsProcessing(true);
    try {
      const audioContext = new AudioContext();
      const response = await fetch(audioUrl);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const audioData = audioBuffer.getChannelData(0);

      const processor = await new audioWorker.current();
      await processor.setParameters({ echoDelay });

      const echoedData = await processor.addEcho(audioData);
      const echoedBuffer = audioContext.createBuffer(
        1,
        echoedData.length,
        audioBuffer.sampleRate
      );
      echoedBuffer.getChannelData(0).set(echoedData);

      const echoedWav = await audioBufferToWav(echoedBuffer);
      const echoedBlobUrl = URL.createObjectURL(
        new Blob([echoedWav], { type: 'audio/wav' })
      );

      setEchoedUrl(echoedBlobUrl);
      setProcessingStage('echo');
      wavesurfer.current?.load(echoedBlobUrl);

      const newMetrics = await processor.getMetrics();
      setMetrics(newMetrics);
    } catch (error) {
      console.error('Error adding echo:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleProcess = async () => {
    if (!audioWorker.current) return;
    const sourceUrl = mode === 'echo' ? echoedUrl : audioUrl;
    if (!sourceUrl) return;

    setIsProcessing(true);
    try {
      const audioContext = new AudioContext();
      const response = await fetch(sourceUrl);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const audioData = audioBuffer.getChannelData(0);

      const processor = await new audioWorker.current();
      
      if (mode === 'echo') {
        const processedData = await processor.removeEcho(audioData);
        const processedBuffer = audioContext.createBuffer(
          1,
          processedData.length,
          audioBuffer.sampleRate
        );
        processedBuffer.getChannelData(0).set(processedData);

        const processedWav = await audioBufferToWav(processedBuffer);
        const processedBlobUrl = URL.createObjectURL(
          new Blob([processedWav], { type: 'audio/wav' })
        );

        setProcessedUrl(processedBlobUrl);
        setProcessingStage('final');
        wavesurfer.current?.load(processedBlobUrl);

        const newMetrics = await processor.getMetrics();
        setMetrics(newMetrics);
      } else {
        const processedData = await processor.processNoiseAndEcho(audioData);
        const processedBuffer = audioContext.createBuffer(
          1,
          processedData.length,
          audioBuffer.sampleRate
        );
        processedBuffer.getChannelData(0).set(processedData);

        const processedWav = await audioBufferToWav(processedBuffer);
        const processedBlobUrl = URL.createObjectURL(
          new Blob([processedWav], { type: 'audio/wav' })
        );

        setProcessedUrl(processedBlobUrl);
        setProcessingStage('final');
        wavesurfer.current?.load(processedBlobUrl);

        const newMetrics = await processor.getMetrics();
        setMetrics(newMetrics);
      }
    } catch (error) {
      console.error('Error processing audio:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePlayAudio = (url: string) => {
    wavesurfer.current?.load(url);
  };

  // Helper function to convert AudioBuffer to WAV format
  const audioBufferToWav = (buffer: AudioBuffer): Promise<ArrayBuffer> => {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    
    const wav = new ArrayBuffer(44 + buffer.length * blockAlign);
    const view = new DataView(wav);
    
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + buffer.length * blockAlign, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, buffer.length * blockAlign, true);
    
    const offset = 44;
    const data = new Int16Array(wav, offset);
    const channelData = buffer.getChannelData(0);
    
    for (let i = 0; i < buffer.length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    }
    
    return Promise.resolve(wav);
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-6 space-y-8">
      <div className="bg-white rounded-xl shadow-lg p-6">
        <h2 className="text-2xl font-bold mb-4">
          {mode === 'echo' ? 'Echo Simulation & Removal' : 'Noise & Echo Removal'}
        </h2>

        <div className="flex gap-4 mb-6">
          <button
            onClick={handleRecordToggle}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <Mic size={20} />
            {isRecording ? 'Stop Recording' : 'Start Recording'}
          </button>

          <label className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 cursor-pointer">
            <Upload size={20} />
            Upload Audio
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>

        <div ref={waveformRef} className="mb-6" />

        {metrics && (
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="text-lg font-semibold mb-2">Performance Metrics</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-medium text-gray-600">Echo Return Loss Enhancement (ERLE)</p>
                <p className="text-lg">{metrics.erle.toFixed(2)} dB</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">Signal to Noise Ratio (SNR)</p>
                <p className="text-lg">{metrics.snr.toFixed(2)} dB</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">Residual Echo Attenuation (REA)</p>
                <p className="text-lg">{metrics.rea.toFixed(2)} dB</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">Processing Latency</p>
                <p className="text-lg">{metrics.latency.toFixed(2)} ms</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-600">Convergence Speed</p>
                <p className="text-lg">{metrics.convergence.toFixed(2)} ms</p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-6">
          {/* Input Audio Controls */}
          {audioUrl && (
            <div className="p-4 border rounded-lg">
              <h3 className="text-lg font-semibold mb-3">Input Audio</h3>
              <button
                onClick={() => handlePlayAudio(audioUrl)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                <Play size={20} />
                Play Input Audio
              </button>
            </div>
          )}

          {/* Echo Stage Controls (Echo Mode Only) */}
          {mode === 'echo' && audioUrl && (
            <div className="p-4 border rounded-lg">
              <h3 className="text-lg font-semibold mb-3">Echo Stage</h3>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block">
                    Echo Delay (ms)
                    <input
                      type="range"
                      min="10"
                      max="500"
                      value={echoDelay}
                      onChange={(e) => setEchoDelay(Number(e.target.value))}
                      className="w-full"
                    />
                    <span className="text-sm text-gray-600">
                      {echoDelay}ms
                    </span>
                  </label>
                </div>
                <button
                  onClick={handleAddEcho}
                  disabled={isProcessing}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-400"
                >
                  {isProcessing ? 'Adding Echo...' : 'Add Echo'}
                </button>
                {echoedUrl && (
                  <button
                    onClick={() => handlePlayAudio(echoedUrl)}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                  >
                    <Play size={20} />
                    Play Echoed Audio
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Final Processing Stage */}
          {((mode === 'echo' && echoedUrl) || (mode === 'noise-echo' && audioUrl)) && (
            <div className="p-4 border rounded-lg">
              <h3 className="text-lg font-semibold mb-3">
                {mode === 'echo' ? 'Echo Removal' : 'Noise & Echo Removal'}
              </h3>
              <div className="space-y-4">
                <button
                  onClick={handleProcess}
                  disabled={isProcessing}
                  className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-400"
                >
                  {isProcessing ? 'Processing...' : 'Process Audio'}
                </button>
                {processedUrl && (
                  <>
                    <button
                      onClick={() => handlePlayAudio(processedUrl)}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                    >
                      <Play size={20} />
                      Play Processed Audio
                    </button>
                    <a
                      href={processedUrl}
                      download="processed-audio.wav"
                      className="block w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-center"
                    >
                      Download Processed Audio
                    </a>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};