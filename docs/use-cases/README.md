# Product ideas for AgentDock forks

> Research snapshot: 2026-09-01. This is a set of product hypotheses, not a claim that every
> concept has product-market fit. The concepts below are inferences from current workflow and
> product signals; validate a narrow customer problem before building a full product.

This catalog is for downstream products built from AgentDock. It is not AgentDock's feature list or
delivery roadmap.

AgentDock is most useful as the supervised runtime inside a focused workflow product: inspect a
real workspace, show progress and evidence, pause before consequential actions, produce a
reviewable artifact, and leave an audit trail. A generic chat window does not use enough of the
boilerplate to be a strong product wedge.

## How to read the directory

The **Profile** column shows which part of AgentDock makes a concept stronger. The **Current
checkout** column names the implemented subset or downstream responsibility. Linked issues
[#15](https://github.com/jortega0033/agentdock/issues/15)-[#18](https://github.com/jortega0033/agentdock/issues/18)
are closed implementation tickets, not maturity or provider-parity guarantees. Verify the selected
branch, provider, platform, and fixture-backed capability before promising it downstream.

| Profile              | Current checkout                            | Meaning                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core**             | Implemented; provider-scoped                | Provider-neutral v2 session lifecycle, streams, interaction routing, workspace trust, audit, durable history, and concurrency exist. Native execution, resume/fork, and interaction support are negotiated capabilities, not universal guarantees.                                                                                                        |
| **MCP**              | Control plane implemented; provider-limited | Daemon routes and normalized control-plane contracts exist. Current production CLI adapters expose only the configuration subset their providers support; live tool/resource/prompt catalogs, provider-owned OAuth, and direct invocation remain unavailable. See closed implementation ticket [#15](https://github.com/jortega0033/agentdock/issues/15). |
| **Extensions**       | Read-only discovery                         | Filesystem discovery can inspect supported skills, plugins, hooks, commands, and agents. The production adapter does not perform management actions or invocation. See closed implementation ticket [#16](https://github.com/jortega0033/agentdock/issues/16).                                                                                            |
| **Agents**           | Worktrees current; subagents scaffolded     | Worktree preview, create, list, and cleanup are implemented. Subagent graph storage and routes exist, but production provider events do not populate the graph and graph controls remain unsupported. See closed implementation ticket [#17](https://github.com/jortega0033/agentdock/issues/17).                                                         |
| **Files**            | Staging and validation only                 | File picking, upload staging, references, and standalone structured-output validation exist. Session creation has no attachment or output-schema field, so neither is dispatched to provider execution. See closed implementation ticket [#18](https://github.com/jortega0033/agentdock/issues/18).                                                       |
| **App layer**        | Downstream-only                             | Product-specific work that AgentDock does not supply: accounts, cloud sync, domain data, licensed content, connectors, evaluations, billing, and distribution.                                                                                                                                                                                            |
| **Regulated review** | Downstream-only                             | A qualified domain reviewer, documented evaluations, and stricter release/action gates are required; AgentDock does not provide the compliance program.                                                                                                                                                                                                   |

Important boundaries:

- A local daemon is not the same as an offline or local-model product. Prompts, selected file
  contents, and tool results can still reach the chosen provider under that provider's policy.
- Provider credentials stay in provider-owned or inherited environments, but every downstream
  product still needs a data-flow and retention review.
- High-stakes legal, medical, financial, employment, security, or compliance concepts should
  prepare evidence and recommendations for a qualified reviewer, not make autonomous decisions.
- MCP servers, repository instructions, hooks, plugins, websites, emails, and documents are all
  potentially untrusted inputs. Keep least privilege and explicit approval at the action boundary.
- AgentDock is fork-oriented boilerplate, not a hosted business backend or a set of public npm
  packages.

## What the research says

The external sources validate workflow shapes, not each product idea. Vendor-reported results are
directional evidence and should not be treated as independent market sizing.

| Signal                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Design implication for AgentDock forks                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Work is moving from ad hoc prompts to repeatable workflows.                           | OpenAI reports rapid growth in structured enterprise workflows and recurring use across coding, support, analysis, content, and automation in its [2025 enterprise AI report](https://openai.com/business/guides-and-resources/the-state-of-enterprise-ai-2025-report/).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Package one repeated job with a clear input, completion state, and reviewable output.           |
| Coding-agent primitives generalize beyond coding.                                     | OpenAI describes analysts, marketers, operators, designers, researchers, investors, and bankers using Codex for internal apps, dashboards, executive materials, and creative work in [Codex for every role, tool, and workflow](https://openai.com/index/codex-for-every-role-tool-workflow/). Anthropic cites financial-compliance, cybersecurity, and debugging agents built with its SDK in [Enabling Claude Code to work more autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously).                                                                                                                                                                                                                                                                                                          | Look for knowledge work that can be expressed as files, tools, checks, and artifacts.           |
| Long-running and parallel work needs a command center.                                | The [Codex app](https://openai.com/index/introducing-the-codex-app/) emphasizes parallel agents, isolated worktrees, long-running tasks, skills, and review queues.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Prefer mission-control and case-desk UIs over a single transcript.                              |
| Source-grounded research is becoming a product category.                              | Google added web research plus Word and spreadsheet sources to [NotebookLM](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-deep-research-file-types/); Microsoft positions [Researcher](https://learn.microsoft.com/en-us/microsoft-365/copilot/researcher-agent) for multi-step work across workplace sources and the web.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Keep sources, claims, transformations, and final artifacts inspectable.                         |
| Human handoff is part of the workflow, not only an error path.                        | [UiPath Agents](https://docs.uipath.com/agents/automation-cloud/latest/user-guide/about-uipath-agents) model tools, context, and escalation components. Intercom documents both escalation and an explicit [human-in-the-loop review](https://www.intercom.com/help/en/articles/12396892-manage-fin-ai-agent-s-escalation-guidance-and-rules).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Design approval and question queues as primary product surfaces.                                |
| Focused vertical agents already cover code, security, sales, finance, and legal work. | Examples include [GitHub agent tasks](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task), Microsoft's [phishing-triage evaluation](https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/microsoft/bade/documents/products-and-services/en-us/security/randomized-controlled-trial-for-phishing-triage-agent-accessible.pdf), [Salesforce lead qualification](https://help.salesforce.com/s/articleView?id=sales.sales_agent_qual_overview.htm&language=en_US&type=5), [Ramp finance agents](https://ramp.com/blog/ramp-agents-announcement), and Thomson Reuters' [agentic legal research and guided workflows](https://www.thomsonreuters.com/en/press-releases/2025/august/thomson-reuters-launches-cocounsel-legal-transforming-legal-work-with-agentic-ai-and-deep-research). | A narrow role, corpus, policy, and output is usually a better wedge than a universal assistant. |
| Tool access makes consent and security visible product requirements.                  | The [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28) calls for explicit consent, user control, and careful treatment of tool execution. OWASP's [AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) covers least privilege and human-in-the-loop controls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Show the proposed action, affected scope, evidence, and durable decision before execution.      |

## Editorial shortlist

This ranking favors concepts that benefit from local workspace access, long-running or parallel
work, a natural approval boundary, inspectable evidence, and a small first integration surface.
The score is an editorial fit score, not market data.

| Rank | Product wedge                          | Smallest credible MVP                                                                                                      |  Fit  | Main lift                                 |
| ---: | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | :---: | ----------------------------------------- |
|    1 | **Dependency Upgrade Studio**          | Scan one package ecosystem, propose one bounded upgrade batch, run tests, and produce a merge-ready report.                |  5/5  | Core; Agents for parallel batches         |
|    2 | **Agent Eval and Regression Lab**      | Replay the same repository fixture through Claude and Codex, compare normalized outcomes, and record a promotion decision. |  5/5  | Core; Extensions and Files later          |
|    3 | **Evidence-to-Brief Studio**           | Turn one selected project folder into a cited decision memo with an evidence appendix.                                     |  5/5  | Core; Files for polished ingestion/export |
|    4 | **CI Failure Investigator**            | Ingest one CI job, reproduce it locally, propose a fix, and attach verification evidence.                                  |  5/5  | Core; MCP for CI systems                  |
|    5 | **Release Readiness Gate**             | Run a versioned checklist across tests, docs, security, and packaging; require a human go/no-go.                           |  5/5  | Core; MCP and Extensions                  |
|    6 | **Compliance Evidence Workbench**      | Map a small set of controls to local evidence, identify gaps, and export a reviewer packet.                                | 4.8/5 | Core; Files and MCP; domain review        |
|    7 | **Support Escalation Investigator**    | Combine one ticket with local logs/config, reproduce the problem, and prepare a handoff packet.                            | 4.7/5 | Core; MCP for help desk/observability     |
|    8 | **Proposal Compliance Matrix**         | Extract requirements from one RFP, map evidence, flag omissions, and produce a review queue.                               | 4.7/5 | Files; structured output; reviewer        |
|    9 | **Spreadsheet Reconciliation Desk**    | Compare two controlled datasets, explain exceptions, and export adjustments only after approval.                           | 4.6/5 | Files; schema validation; domain review   |
|   10 | **Procurement and Vendor Review Desk** | Gather one request, compare vendors, check policy, and route a sourced recommendation for approval.                        | 4.5/5 | MCP and Files; external-action gates      |

## Concept directory

### 1. Agent infrastructure and software delivery

The crowded generic-coding category is still a useful foundation, but the more defensible wedges
are a particular stack, risk regime, migration, or review gate.

| Concept                                       | User and outcome                                                                    | First agent loop                                                                                              | Required human gate                                                  | Profile                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| **Multi-provider repository mission control** | Tech lead supervises several repository tasks without mixing context or changes.    | Split work, run parallel sessions, compare plans/diffs/tests, and preserve lineage.                           | Approve commands, file writes, and integration of the chosen result. | Core · Agents              |
| **Issue-to-PR workbench**                     | Maintainer turns a well-scoped issue into a reviewable change.                      | Read issue and repository, propose plan, edit, test, summarize, and prepare PR material.                      | Approve plan, mutation scope, and publication.                       | Core · MCP · Agents        |
| **Dependency Upgrade Studio**                 | Platform team clears upgrade backlogs in controlled batches.                        | Inventory dependencies, rank risk, update one batch, run checks, and explain failures.                        | Approve each batch and lockfile or config changes.                   | Core · Agents              |
| **Framework Migration Studio**                | Application team modernizes a legacy stack incrementally.                           | Discover patterns, define a transformation recipe, migrate isolated slices, and compare verification results. | Choose recipe and approve each merge boundary.                       | Core · Extensions · Agents |
| **CI Failure Investigator**                   | Developer receives a reproducible root cause and verified fix candidate.            | Pull logs, reproduce locally, trace failure, apply the smallest fix, and rerun the failed gate.               | Approve shell commands, writes, and remote CI retry.                 | Core · MCP                 |
| **Release Readiness Gate**                    | Release manager gets an evidence-backed go/no-go packet.                            | Run versioned test, docs, security, asset, and packaging checks; summarize exceptions.                        | Human owns waiver, tag, publish, and deploy decisions.               | Core · MCP · Extensions    |
| **Agent Eval and Regression Lab**             | AI platform owner compares providers, versions, skills, and policies on real tasks. | Replay sanitized fixtures, score completion/tool behavior/cost, diff regressions, and recommend promotion.    | Approve evaluation rubric and production promotion.                  | Core · Extensions · Files  |

### 2. Research, evidence, and organizational knowledge

These products win by making provenance and deliverables better than a generic “chat with files”
experience.

| Concept                              | User and outcome                                                                      | First agent loop                                                                                             | Required human gate                                              | Profile                         |
| ------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------- |
| **Evidence-to-Brief Studio**         | Analyst turns a project folder and selected web sources into a decision memo.         | Plan research, inspect sources, track claims, resolve gaps, draft brief, and build evidence appendix.        | Approve source set and final external distribution.              | Core · Files                    |
| **Competitive Intelligence Dossier** | Product or strategy lead receives a repeatable competitor update.                     | Compare prior dossier, research changed claims, extract evidence, flag uncertainty, and update the brief.    | Reviewer accepts material claims and publication scope.          | Core · MCP · Files              |
| **Literature Review Workbench**      | Researcher builds a traceable synthesis instead of a pile of summaries.               | Define criteria, screen papers, extract structured findings, cluster disagreements, and draft synthesis.     | Human decides inclusion, interpretation, and citation quality.   | Core · Files                    |
| **Technical Decision Memo Desk**     | Engineering leader gets options grounded in code, constraints, and primary docs.      | Inspect repository, research alternatives, prototype risky assumptions, compare tradeoffs, and draft an ADR. | Human chooses the decision and accepts follow-up work.           | Core · MCP                      |
| **Due-Diligence Evidence Room**      | Investor, buyer, or advisor turns a controlled data room into questions and findings. | Inventory documents, extract claims/obligations, cross-check evidence, build issue list, and draft requests. | Qualified reviewer validates findings and all external requests. | Core · Files · regulated review |
| **Local Knowledge Curator**          | Team converts scattered project files into an onboarding and operating guide.         | Detect duplicates/staleness, propose taxonomy, link decisions to sources, and generate update candidates.    | Approve canonical sources, moves, and deletions.                 | Core · Files · Extensions       |

### 3. Security, privacy, and compliance evidence

Use agents for triage, evidence, and proposed remediation. Keep containment, access changes,
attestations, and legal conclusions behind a separate approval tier.

| Concept                                 | User and outcome                                                                                 | First agent loop                                                                                                    | Required human gate                                                                    | Profile                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- |
| **Control Evidence Mapper**             | GRC team maps a selected framework or policy set to current technical evidence.                  | Read controls, inspect approved repositories/configs, attach evidence, mark gaps, and draft remediation owners.     | Control owner validates mapping and attestation.                                       | Core · MCP · Files                    |
| **Security Questionnaire Desk**         | Security team answers vendor/customer questionnaires consistently and with citations.            | Parse questions, retrieve approved policy evidence, draft answers, flag unsupported claims, and build review queue. | Security/legal owner approves every external answer.                                   | Core · Files · Extensions             |
| **Phishing and Alert Triage Desk**      | Analyst receives enriched evidence, rationale, and a recommended disposition.                    | Inspect message/alert metadata, correlate indicators, search approved sources, and assemble timeline.               | Analyst owns disposition, blocking, deletion, and notification.                        | Core · MCP · Files · regulated review |
| **Vulnerability Remediation Workbench** | Security engineer turns a finding into a tested patch plan.                                      | Reproduce finding, trace affected code, rank fixes, implement isolated candidate, and rerun scanner/tests.          | Approve exploit-like commands, patch, and rollout.                                     | Core · MCP · Agents                   |
| **Privacy Request and Records Desk**    | Privacy/records team prepares a bounded case packet for access, correction, export, or deletion. | Identify systems and records, collect evidence, deduplicate, propose actions, and document exceptions.              | Identity verification, legal decisions, exports, and deletion remain human-controlled. | Core · MCP · Files · regulated review |
| **MCP and Extension Trust Inspector**   | AI administrator understands what a server, skill, plugin, or hook can read and execute.         | Discover manifests, classify scopes/effects/secrets, diff changes, simulate policy, and recommend enablement.       | Explicit enable/disable and every consequential tool call.                             | MCP · Extensions                      |

### 4. Investigation, IT operations, and product quality

The shared product shape is a case timeline: collect evidence, reproduce or correlate, propose the
next safe step, ask for approval, verify, and update the runbook.

| Concept                               | User and outcome                                                                              | First agent loop                                                                                                 | Required human gate                                                 | Profile                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| **Incident Timeline Builder**         | Incident lead gets one chronology from logs, tickets, changes, and notes.                     | Collect bounded sources, normalize timestamps, link claims to evidence, identify gaps, and draft updates.        | Incident lead approves status and postmortem claims.                | Core · MCP · Files                         |
| **Runbook-Guided Incident Commander** | SRE receives diagnostic steps and rollback options without blind automation.                  | Select runbook, gather state, execute read-only checks, propose change, wait, verify, and record outcome.        | Every write, restart, failover, rollback, or external notification. | Core · MCP · Extensions · regulated review |
| **Support Escalation Investigator**   | Support engineer receives reproduction steps, likely root cause, and a clean handoff packet.  | Read ticket, inspect local diagnostics, reproduce, search known issues, propose fix/workaround, and draft reply. | Approve customer communication and account/system changes.          | Core · MCP                                 |
| **Bug Reproduction Cockpit**          | QA or developer turns an ambiguous report into a minimal, verified case.                      | Ask structured questions, capture environment, generate hypotheses, run variants, and preserve artifacts.        | Approve risky test commands and issue publication.                  | Core · Files · Agents                      |
| **Data Quality Incident Desk**        | Data owner explains an anomalous dataset and proposed correction.                             | Profile inputs, trace lineage, compare expected constraints, isolate bad rows, and generate correction preview.  | Approve source mutation, backfill, and downstream rerun.            | Core · MCP · Files                         |
| **UI Quality Workbench**              | Product team reviews accessibility, localization, visual regression, and content consistency. | Run checkers, inspect screens and source, cluster failures, propose fixes, and rerun validation.                 | Product owner accepts copy, visual, and accessibility tradeoffs.    | Core · Extensions · Files                  |

### 5. Finance, legal, procurement, and controlled back office

The strongest pattern is “prepare, explain, show evidence, then a professional approves.” Do not
market these as autonomous legal, accounting, tax, credit, or payment decisions.

| Concept                                       | User and outcome                                                                   | First agent loop                                                                                                            | Required human gate                                             | Profile                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| **Contract Playbook Review Desk**             | Legal/ops team compares agreements against its own approved playbook.              | Extract clauses, map deviations, cite source text, propose questions/redlines, and rank review queue.                       | Qualified legal reviewer owns advice, redlines, and signature.  | Core · Files · Extensions · regulated review |
| **Procurement and Vendor Review Desk**        | Requester and approvers receive a complete, comparable purchase packet.            | Clarify need, research vendors, collect security/legal evidence, score against policy, and route recommendation.            | Vendor contact, commitment, PO, payment, and contract approval. | Core · MCP · Files                           |
| **Spend Policy Reviewer**                     | Finance team sees exceptions with the binding rule and supporting evidence.        | Ingest transaction and receipt, find applicable policy, explain classification, request missing data, and recommend action. | Reviewer approves exception, reimbursement, or enforcement.     | Core · MCP · Files · regulated review        |
| **Invoice Exception Desk**                    | AP team resolves mismatches instead of manually re-reading every document.         | Extract invoice/PO/receipt, perform match, explain variance, gather missing evidence, and prepare adjustment.               | Approve coding, payment, supplier contact, or rejection.        | Core · MCP · Files · regulated review        |
| **Spreadsheet Reconciliation and Close Desk** | Analyst receives reproducible exceptions and a review-ready close packet.          | Validate inputs, run transparent transformations, reconcile, explain anomalies, and export proposed entries.                | Finance owner approves assumptions, entries, and final report.  | Core · Files · regulated review              |
| **Audit Binder and Workpaper Prep**           | Auditor or tax professional gets indexed support tied to each workpaper assertion. | Inventory evidence, extract facts, cross-reference support, flag gaps, and assemble reviewer packet.                        | Qualified professional signs off conclusions and filings.       | Core · Files · Extensions · regulated review |

### 6. Customer, revenue, proposals, and content operations

External communication creates reputational and regulatory risk. The first product version should
usually draft and route rather than send autonomously.

| Concept                                          | User and outcome                                                                           | First agent loop                                                                                             | Required human gate                                              | Profile                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------- |
| **Proposal Compliance Matrix**                   | Bid team sees every requirement, source, owner, answer, and omission in one review queue.  | Parse requirements, map evidence, assign gaps, draft compliant responses, and validate final package.        | Proposal owner approves claims and submission.                   | Core · Files · Extensions |
| **RFP Response Studio**                          | Services or sales team reuses approved evidence without copying stale answers.             | Classify questions, retrieve current sources, draft answer set, detect contradictions, and assemble package. | Legal/security/commercial review before delivery.                | Core · MCP · Files        |
| **Account Research and Lead Qualification Desk** | Seller gets a sourced account brief, fit rationale, and next-best questions.               | Research company, compare ICP, inspect approved CRM context, score evidence, and draft outreach options.     | Seller owns qualification, messaging, and CRM changes.           | Core · MCP · Files        |
| **Customer Success Renewal Prep**                | CSM receives an evidence-backed health and renewal plan.                                   | Aggregate usage/tickets/commitments, identify risks and wins, draft agenda, and propose follow-ups.          | CSM approves health judgment, offer, and customer communication. | Core · MCP                |
| **Voice-of-Customer and Knowledge-Gap Miner**    | Product/support leads turn conversations into themes, examples, and missing documentation. | Sample cases, cluster issues, link evidence, estimate recurrence, and draft backlog/docs updates.            | Human validates sampling, prioritization, and publication.       | Core · MCP · Files        |
| **Documentation Release Verifier**               | Docs lead knows that product, API, screenshots, examples, and release notes agree.         | Diff release, trace affected docs, run examples/link checks, update candidates, and produce coverage report. | Approve public docs and versioned claims.                        | Core · MCP · Extensions   |
| **Campaign and Brand Content Factory**           | Marketing team turns one approved brief into channel variants that remain source-grounded. | Inspect brand rules and evidence, draft variants, run claim/brand checks, and assemble approval queue.       | Brand/legal owner approves claims and publication.               | Core · Extensions · Files |

### 7. Vertical and prosumer workbenches

These are narrower applications of the same case-desk, review-queue, and evidence-room patterns.
The vertical data model and evaluation set—not the system prompt—should become the product moat.

| Concept                                 | User and outcome                                                                                           | First agent loop                                                                                                 | Required human gate                                                | Profile                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| **Construction Bid Desk**               | Estimator turns plans, specifications, addenda, and vendor quotes into a compliant bid checklist.          | Index package, extract scope, identify conflicts, map quotes, draft clarifications, and build submission matrix. | Estimator approves quantities, price, assumptions, and submission. | Core · MCP · Files · regulated review |
| **Manufacturing CAPA Workbench**        | Quality team prepares a traceable corrective/preventive-action investigation.                              | Collect incident evidence, build chronology, test root-cause hypotheses, map procedures, and draft actions.      | Quality owner approves cause, action, validation, and closure.     | Core · MCP · Files · regulated review |
| **Logistics Exception Resolver**        | Operator gets the evidence and options for delayed, damaged, or mismatched shipments.                      | Gather order/carrier/warehouse state, explain exception, compare policy options, and draft communications.       | Human approves reroute, refund, replacement, or customer promise.  | Core · MCP                            |
| **Property Maintenance Coordinator**    | Manager converts tenant reports, asset history, quotes, and policy into a work-order recommendation.       | Clarify issue, inspect records, triage urgency, compare vendors, and prepare tenant/contractor updates.          | Human approves access, dispatch, spend, and safety decisions.      | Core · MCP · Files                    |
| **Grant Compliance Desk**               | Nonprofit or research team maps obligations, evidence, deadlines, and narrative updates.                   | Parse award terms, build obligation calendar, link evidence, flag gaps, and draft reports.                       | Program/finance owner approves certifications and submission.      | Core · MCP · Files · regulated review |
| **Career Application Studio**           | Job seeker maintains evidence-backed resume variants, work samples, and interview packets locally.         | Match role to verified experience, identify gaps, tailor materials, and prepare interview research.              | User approves every claim and submission.                          | Core · MCP · Files                    |
| **Academic or Creator Research Studio** | Researcher/creator turns a private archive plus selected sources into cited articles, lessons, or scripts. | Curate sources, build outline, trace claims, draft variants, and package attribution.                            | Author approves interpretation, rights, and publication.           | Core · Files · Extensions             |

## Deeper source map by concept family

These primary sources expose the rules, schemas, APIs, or evidence structures that make a focused
agent workflow more than a prompt wrapper:

- **Software delivery:** [NIST SSDF](https://csrc.nist.gov/pubs/sp/800/218/final) defines a
  common secure-development practice vocabulary; GitHub exposes machine-readable
  [SBOM exports](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/export-dependencies-as-sbom)
  and [check-run annotations and actions](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks).
- **Security and AI governance:** [NIST CSF 2.0](https://www.nist.gov/publications/nist-cybersecurity-framework-csf-20)
  provides outcome and profile structures, while the
  [NIST AI RMF](https://www.nist.gov/itl/ai-risk-management-framework) provides a vocabulary for
  governing and measuring AI risk.
- **Incident and infrastructure operations:** [NIST SP 800-61r3](https://csrc.nist.gov/pubs/sp/800/61/r3/final)
  covers incident-response integration with risk management; Kubernetes documents structured
  [audit records](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/) for correlating
  actors, requests, resources, and outcomes.
- **Privacy and records:** the European Commission documents how organizations should handle
  [individual data-rights requests](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/dealing-requests-individuals_en),
  NIST publishes a [Privacy Framework](https://www.nist.gov/privacy-framework), and NARA describes
  [records inventory and disposition](https://www.archives.gov/records-mgmt/scheduling/implementation).
- **Finance and structured documents:** [Peppol BIS Billing](https://docs.peppol.eu/poacc/billing/3.0/bis/)
  exposes staged syntax, business-rule, and national-rule validation; the SEC provides
  [EDGAR filing and XBRL APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).
- **Content and catalog quality:** standards such as
  [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [XLIFF 2.1](https://www.oasis-open.org/standard/xliffv2-1/),
  and the [GS1 Global Data Model](https://www.gs1.org/standards/gs1-global-data-model) give agents
  deterministic checks and controlled schemas around otherwise subjective review work.
- **Bids and grants:** official APIs exist for
  [TED procurement notices](https://docs.ted.europa.eu/api/latest/search.html),
  [SAM.gov opportunities](https://open.gsa.gov/api/get-opportunities-public-api/), and
  [Grants.gov](https://www.grants.gov/api), making discovery and amendment tracking plausible
  while keeping pursue/pass and submission decisions human-owned.

## A reusable product anatomy

Most of the concepts above can share the same product skeleton:

1. **Intake:** one folder, case, issue, alert, transaction, or document set enters a bounded session.
2. **Plan:** the agent states its steps, requested capabilities, data sources, and expected artifact.
3. **Evidence:** progress appears as a structured timeline with source and tool provenance.
4. **Gate:** questions and consequential actions enter an explicit human review queue.
5. **Action:** approved tools operate only within the selected workspace and integration scope.
6. **Verification:** the agent reruns checks and separates observed facts from inference.
7. **Artifact:** the product exports a diff, matrix, brief, workpaper, issue, or action packet.
8. **Memory:** lineage, decisions, and safe normalized history support resume, fork, and audit.

This skeleton is a better starting point than preserving the reference desktop's generic composer.
Replace the composer with the domain intake form, the provider panel with policy-aware defaults,
and the raw timeline with domain-specific evidence and approval cards.

## Choosing what to build

Score a candidate workflow from 0-2 on each question:

- Does it happen repeatedly for a clearly identified user?
- Does the work live in local files, repositories, or desktop-accessible tools?
- Is there a bounded case with an observable “done” state?
- Can the agent show evidence and run verification instead of merely sounding plausible?
- Is there a natural approval boundary before expensive or irreversible action?
- Can the first version use one input source, one action integration, and one artifact type?
- Are past cases available to create deterministic fixtures and outcome evaluations?
- Will workflow knowledge, policy, or proprietary data create differentiation beyond the model?

Prefer concepts scoring at least 12/16. Start with **draft → review → approved action**, and add
autonomy only after measured reliability justifies a narrower approval policy.

## Keeping the directory current

- Recheck the linked sources and product landscape every 6-12 months.
- Update capability tags and statuses when runtime behavior or capability manifests change. Treat
  [Epic #4](https://github.com/jortega0033/agentdock/issues/4) and closed implementation tickets
  [#15](https://github.com/jortega0033/agentdock/issues/15)-[#18](https://github.com/jortega0033/agentdock/issues/18)
  as historical implementation context, not the current maturity source.
- Add customer-interview evidence separately from vendor product evidence.
- Promote a concept into its own page only after it has a named persona, repeated job, first
  integration, evaluation set, approval policy, and explicit non-goals.
