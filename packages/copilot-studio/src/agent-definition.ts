import { promises as fs } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('copilot-studio:agent-definition');

export interface AgentDefinition {
  uniqueName: string;
  displayName: string;
  description?: string;
  instructions: string;
  topics: Topic[];
  generativeAnswers?: { enabled: boolean; sources?: string[] };
  greeting?: string;
  brand?: { primaryColor?: string };
}

export interface Topic {
  name: string;
  triggerPhrases: string[];
  nodes: TopicNode[];
}

export type TopicNode =
  | { kind: 'message'; text: string }
  | { kind: 'question'; prompt: string; variable: string }
  | { kind: 'action'; action: string; inputs?: Record<string, unknown> };

export interface WriteOptions {
  publisherName?: string;
  publisherPrefix?: string;
  publisherUniqueName?: string;
  solutionUniqueName?: string;
  solutionDisplayName?: string;
  solutionVersion?: string;
}

/** Write a Copilot Studio agent solution skeleton to disk. */
export async function writeAgentDefinition(
  targetDir: string,
  def: AgentDefinition,
  opts: WriteOptions = {},
): Promise<void> {
  const publisherName = opts.publisherName ?? 'AppFactory';
  const publisherPrefix = opts.publisherPrefix ?? 'af';
  const publisherUniqueName = opts.publisherUniqueName ?? 'appfactory';
  const solutionUniqueName = opts.solutionUniqueName ?? def.uniqueName;
  const solutionDisplayName = opts.solutionDisplayName ?? def.displayName;
  const solutionVersion = opts.solutionVersion ?? '1.0.0.0';

  await fs.mkdir(path.join(targetDir, 'Other'), { recursive: true });
  await fs.mkdir(path.join(targetDir, 'bot'), { recursive: true });

  const solutionXml = renderSolutionXml({
    solutionUniqueName,
    solutionDisplayName,
    solutionVersion,
    publisherUniqueName,
    publisherName,
    publisherPrefix,
    botUniqueName: def.uniqueName,
  });
  await fs.writeFile(path.join(targetDir, 'Other', 'Solution.xml'), solutionXml, 'utf8');

  const customizationsXml = renderCustomizationsXml(def);
  await fs.writeFile(path.join(targetDir, 'Other', 'Customizations.xml'), customizationsXml, 'utf8');

  await fs.writeFile(path.join(targetDir, 'Other', 'Relationships.xml'), renderRelationshipsXml(), 'utf8');
  await fs.writeFile(path.join(targetDir, '[Content_Types].xml'), renderContentTypesXml(), 'utf8');

  const botJson = renderBotJson(def);
  await fs.writeFile(
    path.join(targetDir, 'bot', `${def.uniqueName}.json`),
    JSON.stringify(botJson, null, 2),
    'utf8',
  );

  for (const topic of def.topics) {
    await fs.writeFile(
      path.join(targetDir, 'bot', `topic.${slug(topic.name)}.json`),
      JSON.stringify(topic, null, 2),
      'utf8',
    );
  }

  log.info({ targetDir, topics: def.topics.length }, 'agent solution skeleton written');
}

/** Zip a solution directory into a `pac solution import`-ready archive. */
export async function zipSolution(srcDir: string, outZip: string): Promise<string> {
  const stat = await fs.stat(srcDir).catch(() => undefined);
  if (!stat || !stat.isDirectory()) {
    throw new AppFactoryError('AGENT_DEFINITION_MISSING_DIR', `solution dir not found: ${srcDir}`);
  }
  await fs.mkdir(path.dirname(outZip), { recursive: true });
  const zip = new AdmZip();
  zip.addLocalFolder(srcDir);
  zip.writeZip(outZip);
  log.info({ outZip }, 'solution zipped');
  return outZip;
}

// ---------------------------------------------------------------------------
// XML/JSON renderers
// ---------------------------------------------------------------------------

interface SolutionXmlArgs {
  solutionUniqueName: string;
  solutionDisplayName: string;
  solutionVersion: string;
  publisherUniqueName: string;
  publisherName: string;
  publisherPrefix: string;
  botUniqueName: string;
}

function renderSolutionXml(a: SolutionXmlArgs): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="appfactory" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${xml(a.solutionUniqueName)}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${xml(a.solutionDisplayName)}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>${xml(a.solutionVersion)}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${xml(a.publisherUniqueName)}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${xml(a.publisherName)}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions />
      <EMailAddress />
      <SupportingWebsiteUrl />
      <CustomizationPrefix>${xml(a.publisherPrefix)}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>10000</CustomizationOptionValuePrefix>
      <Addresses />
    </Publisher>
    <RootComponents>
      <RootComponent type="29" schemaName="${xml(a.botUniqueName)}" behavior="0" />
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
`;
}

function renderCustomizationsXml(def: AgentDefinition): string {
  const topicsXml = def.topics
    .map(
      (t) =>
        `      <Topic name="${xml(t.name)}"><TriggerPhrases>${t.triggerPhrases
          .map((tp) => `<TriggerPhrase>${xml(tp)}</TriggerPhrase>`)
          .join('')}</TriggerPhrases><NodesJson>${xml(JSON.stringify(t.nodes))}</NodesJson></Topic>`,
    )
    .join('\n');
  const ga = def.generativeAnswers ?? { enabled: false };
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Bots>
    <Bot uniqueName="${xml(def.uniqueName)}" displayName="${xml(def.displayName)}">
      <Description>${xml(def.description ?? '')}</Description>
      <Instructions>${xml(def.instructions)}</Instructions>
      <Greeting>${xml(def.greeting ?? '')}</Greeting>
      <GenerativeAnswers enabled="${ga.enabled ? 'true' : 'false'}">
        ${(ga.sources ?? []).map((s) => `<Source>${xml(s)}</Source>`).join('')}
      </GenerativeAnswers>
      <Brand primaryColor="${xml(def.brand?.primaryColor ?? '')}" />
      <Topics>
${topicsXml}
      </Topics>
    </Bot>
  </Bots>
  <EntityMaps />
  <EntityRelationships />
  <OptionSets />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <EntityDataProviders />
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>
`;
}

function renderRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<EntityRelationships xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" />
`;
}

function renderContentTypesXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/octet-stream" />
  <Default Extension="json" ContentType="application/octet-stream" />
</Types>
`;
}

function renderBotJson(def: AgentDefinition): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    uniqueName: def.uniqueName,
    displayName: def.displayName,
    description: def.description ?? '',
    instructions: def.instructions,
    greeting: def.greeting ?? '',
    generativeAnswers: def.generativeAnswers ?? { enabled: false, sources: [] },
    brand: def.brand ?? {},
    topicFiles: def.topics.map((t) => `topic.${slug(t.name)}.json`),
  };
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'topic';
}
