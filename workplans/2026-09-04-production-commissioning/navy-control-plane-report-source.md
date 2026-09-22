# Navy-derived Agent OS control-plane research source

Status: research evidence pack. This is not a compliance determination, government endorsement, implementation proof, or production authority.

## Source boundaries

- The supplied NIWC Pacific `/VISION/` page presents *Sea Strike 2043*; it does not establish a separate published architecture named VISION.
- The public film is a future-concept thinking aid, not evidence that depicted capabilities are operational.
- Public DON material defines the electromagnetic-spectrum enterprise across policy, governance, organization, equipment, procedures, doctrine, information, facilities, training, and materiel. It does not verify one monolithic software product called Spectrum.
- Government requirements are mandatory only for covered systems or contracts that incorporate them. Ashlr uses transferable engineering patterns without asserting government compliance.

## Provenance records

### Sea Strike 2043

- Claim: The film depicts a deadline-bound sense, simulate, dynamically compose, coordinate, and explicitly authorize loop.
- Evidence: course-of-action simulation, pre-authorized cyber capability, modular software/payload changes, distributed reconnaissance and communications, RF sensing, synchronized effects, and an authorization request before automated launch.
- Publisher/date: NIWC Pacific / DVIDS, January 2025.
- Sources: https://www.niwcpacific.navy.mil/VISION/ and https://www.dvidshub.net/video/950543/sea-strike-2043
- Confidence: high for depicted sequence; low as evidence of fielded capability.
- Gap: DVIDS marks captions incomplete/unreviewed.

### Electromagnetic-spectrum enterprise

- Claim: The transferable model is an enterprise and scarce-resource orchestration problem, not merely a software scheduler.
- Evidence: DON governance charter spans policy, governance, organization, equipment, procedures, doctrine, information, facilities, training, and materiel.
- Publisher/date: DON CIO, September 2020.
- Source: https://www.doncio.navy.mil/FileHandler.ashx?id=16121
- Confidence: high.
- Gap: the Pentagon discussion may have referenced a non-public system or shorthand.

### Spectrum on Demand

- Claim: The current public concept uses distributed sensing, interference monitoring, predictive congestion management, dynamic allocation, machine-speed response, and human oversight.
- Publisher/date: DON CIO/CHIPS, April-June 2026.
- Source: https://www.doncio.navy.mil/chips/ArticleDetails.aspx?ID=20514
- Confidence: high for the concept description; medium for maturity.
- Gap: the article does not prove fleetwide operational deployment or validated performance.

### DoD Zero Trust outcomes

- Claim: Target-level Zero Trust is organized as measurable capabilities and activities with enterprise/component responsibilities and an end-of-FY2027 target.
- Publisher/date: DoD CIO, January 22, 2025.
- Source: https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-CapabilitiesActivities.pdf
- Confidence: high.
- Ashlr transfer: machine-readable capability, activity, outcome, evidence, and state transitions; do not equate implementation with effectiveness, commissioning, or authority.

### Continuous authorization

- Claim: Continuous authorization depends on ongoing visibility, active defense, an approved DevSecOps design, risk dashboards, distinct authorization, and revocation when posture degrades.
- Publisher/date: DoD CIO, February 4, 2022.
- Source: https://dodcio.defense.gov/Portals/0/Documents/Library/20220204-cATO-memo.PDF
- Confidence: high.
- Ashlr transfer: agents gather evidence and recommend; a distinct current authority issues scoped, expiring, revocable production grants.

### ICAM for people and non-person entities

- Claim: DoD ICAM covers identity, attributes, credentials, authentication, and resource-context access decisions for people and non-person entities.
- Publisher/dates: DoD CIO, 2020.
- Sources: https://dodcio.defense.gov/Portals/0/Documents/Cyber/ICAM_Strategy.pdf and https://dodcio.defense.gov/Portals/0/Documents/Cyber/DoD_Enterprise_ICAM_Reference_Design.pdf
- Confidence: high.
- Ashlr transfer: durable identities for agents, model endpoints, accounts, daemons, browser sessions, tools, brokers, repositories, and credentials; JIT capabilities with expiry and revocation.

### Policy control plane

- Claim: NIST separates a policy engine, policy administrator, and policy enforcement point. The engine and administrator together make the policy decision point.
- Publisher/date: NIST, August 2020.
- Source: https://csrc.nist.gov/pubs/sp/800/207/final
- Confidence: high.
- Ashlr transfer: non-effecting policy engine; constrained capability administrator as a PA specialization; local broker as PEP.

### Independent products, shared data fabric

- Claim: DoD's VAULTIS goals emphasize visible, accessible, understandable, linked, trustworthy, interoperable, and secure data using catalogs, semantic metadata, standard APIs, and common services.
- Publisher/date: DoD, 2020.
- Source: https://media.defense.gov/2020/Oct/08/2002514180/-1/-1/0/DOD-DATA-STRATEGY.PDF
- Confidence: high.
- Ashlr transfer: keep Hub, Cortex, Phantom, Locus, Plugin, Stack, and Core Efficiency independently useful while joining them through typed identity, provenance, event, and capability contracts.

## Applied architecture

The evidence supports one high-value synthesis: Ashlr Hub should be a local-first policy control plane for a system of independent products and distributed enforcement points. It continuously senses values-free resource posture, simulates competing courses of action, allocates finite model/compute/tool capacity through identity-scoped leases, executes only through narrow enforcement capabilities, measures independently defined outcomes, and escalates consequential exceptions with a complete evidence packet.

The canonical product translation and frozen acceptance requirements are maintained in `docs/AGENT-OS-DOCTRINE.md` on draft PR #332.
