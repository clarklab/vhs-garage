import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playStaticNoise } from '../../public/scripts/tik/tv-static.js';

test('static is a quarter-second of bounded noise at 15%, routed only to the render', () => {
  const nodes = [];
  const envelope = [];
  const makeNode = () => {
    const node = { connections: [], disconnected: false,
      connect(to) { this.connections.push(to); },
      disconnect() { this.disconnected = true; },
    };
    nodes.push(node);
    return node;
  };
  let samples, source, filter, gain;
  const dest = {};
  const ctx = {
    currentTime: 10, sampleRate: 48000, destination: {},
    createBuffer(channels, length, rate) {
      assert.equal(channels, 1);
      assert.equal(length / rate, 0.25);
      samples = new Float32Array(length);
      return { getChannelData: () => samples };
    },
    createBufferSource() {
      source = Object.assign(makeNode(), {
        starts: [], stops: [],
        start(time) { this.starts.push(time); },
        stop(time) { this.stops.push(time); },
      });
      return source;
    },
    createBiquadFilter() {
      filter = Object.assign(makeNode(), { frequency: {}, Q: {} });
      return filter;
    },
    createGain() {
      gain = Object.assign(makeNode(), { gain: {
        setValueAtTime(value, time) { envelope.push(['set', value, time]); },
        linearRampToValueAtTime(value, time) { envelope.push(['ramp', value, time]); },
      } });
      return gain;
    },
  };
  const stop = playStaticNoise({ ctx, dest, meter: {}, speaker: {} });
  assert.ok(samples.every((sample) => Math.abs(sample) <= 1));
  assert.ok(samples.some((sample) => sample !== 0));
  assert.deepEqual(source.starts, [10]);
  assert.deepEqual(source.stops, [10.25]);
  assert.deepEqual(envelope, [['set', 0, 10], ['ramp', 0.15, 10.008], ['set', 0.15, 10.22], ['ramp', 0, 10.25]]);
  assert.equal(filter.type, 'lowpass');
  assert.equal(filter.frequency.value, 5500);
  assert.deepEqual(source.connections, [filter]);
  assert.deepEqual(filter.connections, [gain]);
  assert.deepEqual(gain.connections, [dest]);
  source.onended();
  assert.ok(nodes.every((node) => node.disconnected), 'natural end releases every effect node');
  nodes.forEach((node) => { node.disconnected = false; });
  stop();
  assert.equal(source.stops.length, 2, 'cancel stops the source immediately too');
  assert.ok(nodes.every((node) => node.disconnected));
});

test('a browser without Web Audio can still render the visual channel change', () => {
  assert.doesNotThrow(() => playStaticNoise(null)());
});
