import Image from 'next/image';

const providers = [
  {
    name: 'OpenAI Codex',
    image: '/brands/openai.svg',
    type: 'Native worker adapter',
    description:
      'Account-scoped native workers with quota-aware routing. Enroll separately authenticated Codex profiles.',
    className: 'brand-wordmark',
  },
  {
    name: 'Claude Code',
    image: '/brands/claude.svg',
    type: 'Native worker adapter',
    description:
      'Native workers with isolated profiles and usage visibility where available. Enroll separately authenticated Claude Code accounts.',
    className: 'brand-wordmark',
  },
  {
    name: 'Grok Build',
    image: '/brands/grok.png',
    type: 'Profile and usage monitoring',
    description:
      'Prepare an isolated profile and inspect account or billing evidence. Task execution is not yet available.',
    className: 'brand-icon',
  },
  {
    name: 'Ollama',
    image: '/brands/ollama.svg',
    type: 'Local candidate generation',
    description:
      'Generate candidates through an explicitly configured loopback endpoint and an already-installed model.',
    className: 'brand-ollama',
  },
];
const models = [
  { name: 'Llama', href: 'https://ollama.com/library/llama3.3' },
  { name: 'Qwen', href: 'https://ollama.com/library/qwen3' },
  { name: 'Gemma', href: 'https://ollama.com/library/gemma3' },
  { name: 'DeepSeek', href: 'https://ollama.com/library/deepseek-r1' },
];

export function ProviderEcosystem() {
  return (
    <div className="provider-ecosystem">
      <ul
        className="provider-grid"
        aria-label="Provider integration capabilities"
      >
        {providers.map((provider) => (
          <li key={provider.name}>
            <div className="brand-surface">
              <Image
                src={provider.image}
                alt=""
                width={180}
                height={72}
                className={provider.className}
                unoptimized
              />
            </div>
            <div className="provider-copy">
              <h3>{provider.name}</h3>
              <span className="provider-type">{provider.type}</span>
              <p>{provider.description}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="local-models">
        <div>
          <h3>A local model is your choice.</h3>
          <p>
            Explore model families available through Ollama. Each exact model
            and hardware setup needs its own calibration; these are not
            universal compatibility certifications.
          </p>
        </div>
        <ul aria-label="Local model family examples">
          {models.map((model) => (
            <li key={model.name}>
              <a href={model.href}>
                {model.name}
                <span aria-hidden="true">↗</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <div className="provider-notes">
        <p>
          Connect multiple Codex or Claude Code accounts through distinct
          authenticated native profiles. Browser sign-in alone does not enroll a
          worker. Keep shared quota identities and personal reserves explicit.
        </p>
        <p>
          Integration capability is not a connected account or a verified
          provider run. Product names and marks identify their respective
          providers; no affiliation or endorsement is implied.
        </p>
      </div>
    </div>
  );
}
