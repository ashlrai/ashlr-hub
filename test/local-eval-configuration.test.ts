import { describe, expect, it } from 'vitest';
import { projectConfigurationMetadata } from '../src/core/local-eval/configuration.js';
import type { HarnessConfiguration } from '../src/core/local-eval/types.js';

const configuration: HarnessConfiguration = { model: 'qwen-fixture:27b', modelPath: '/models/sha256-' + 'a'.repeat(64),
  quantization: 'Q8', slots: 4, contextPerSlot: 65536, contextTotal: 262144, samplingParams: { temperature: 1, top_k: 20 },
  baseUrl: 'http://127.0.0.1:9000', proxy: 'on', tracing: 'on', proxyImplementation: 'proxy --port 9000',
  agentCli: 'fixture-agent 1.2.3', llamaServerArgv: ['llama-server', '-c', '262144', '--parallel', '4'], capturedAt: '2026-10-01' };

describe('benchmark configuration credential projection', () => {
  it('keeps observed model digest, runtime and sampling while declaring projected identity', () => {
    const projected = projectConfigurationMetadata(configuration);
    expect(projected).toMatchObject({ model: configuration.model, modelPath: configuration.modelPath, slots: 4,
      contextTotal: 262144, samplingParams: { temperature: 1, top_k: 20 }, agentCli: 'fixture-agent 1.2.3',
      metadataProjection: { version: 1, credentials: 'redacted', processIdentity: 'projected-argv', urlQueries: 'omitted' } });
    expect(projected.llamaServerArgv).toEqual(configuration.llamaServerArgv);
    expect(configuration).not.toHaveProperty('metadataProjection');
  });
  it('strips both proxy and runtime auth flags, split headers, URL userinfo and query credentials', () => {
    const secret = 'SECRET_SENTINEL_ONLY_FIXTURE';
    const projected = projectConfigurationMetadata({ ...configuration,
      baseUrl: `https://operator:${secret}@localhost:9000/v1?token=${secret}&top_k=20#${secret}`,
      proxyImplementation: `proxy --header Authorization: Bearer ${secret} --port 9000 --api-key=${secret} https://operator:${secret}@localhost:9001/path?key=${secret}`,
      llamaServerArgv: ['llama-server', '--api-key', secret, '--header', 'Authorization:', 'Bearer', secret,
        '--parallel', '4', '--header=Authorization:', 'Bearer', secret, '--auth', 'Bearer', secret, '--port', '9001', `https://operator:${secret}@localhost/path?password=${secret}`],
      agentCli: `fixture-agent 1.2.3 Authorization: Bearer ${secret}`,
      samplingParams: { temperature: 1, top_k: 20, seed: secret, token: secret },
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect(projected.baseUrl).toBe('https://localhost:9000/v1');
    expect(projected.proxyImplementation).toContain('--port 9000');
    expect(projected.llamaServerArgv).toContain('9001');
    expect(projected.samplingParams).toEqual({ temperature: 1, top_k: 20 });
  });
  it('does not erase scalar provenance for credential differences or pretend to compare credentials', () => {
    const left = projectConfigurationMetadata({ ...configuration, proxyImplementation: 'proxy --api-key FIRST_SECRET_SENTINEL' });
    const right = projectConfigurationMetadata({ ...configuration, proxyImplementation: 'proxy --api-key SECOND_SECRET_SENTINEL' });
    expect(left.proxyImplementation).toBe(right.proxyImplementation);
    expect(left.metadataProjection?.processIdentity).toBe('projected-argv');
    expect(projectConfigurationMetadata(left)).toEqual(left);
  });
  it('redacts known secret assignments and tokens in free version/error text', () => {
    const secret = 'SECRET_SENTINEL_ONLY_FIXTURE';
    const projected = projectConfigurationMetadata({ ...configuration, agentCli: `runtime error password=${secret}`,
      proxyImplementation: `proxy failed AUTH_TOKEN=${secret}` });
    expect(JSON.stringify(projected)).not.toContain(secret);
  });
});
