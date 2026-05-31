import { describe, it, expect } from 'vitest';
import {
  allRecipes,
  getRecipe,
  copilotStudioSupportBot,
  copilotStudioFieldService,
  teamsBotBasic,
  teamsTabBasic,
  teamsMessageExtension,
  teamsAgent365,
} from '../src/recipes.js';
import { Recipe } from '../src/schema.js';

const EXPECTED_IDS = [
  'copilot-studio-support-bot',
  'copilot-studio-field-service',
  'teams-bot-basic',
  'teams-tab-basic',
  'teams-message-extension',
  'teams-agent-365',
] as const;

describe('recipe library', () => {
  it('exports exactly six recipes in the documented order', () => {
    expect(allRecipes.map((r) => r.id)).toEqual([...EXPECTED_IDS]);
  });

  it.each(allRecipes.map((r) => [r.id, r] as const))(
    'recipe %s parses cleanly under the Recipe zod schema',
    (_id, recipe) => {
      const parsed = Recipe.parse(recipe);
      expect(parsed.id).toBe(recipe.id);
      expect(parsed.questions.length).toBeGreaterThan(0);
    },
  );

  it.each(EXPECTED_IDS.map((id) => [id] as const))(
    'getRecipe("%s") returns the matching recipe',
    (id) => {
      const r = getRecipe(id);
      expect(r).toBeDefined();
      expect(r?.id).toBe(id);
    },
  );

  it('getRecipe returns undefined for an unknown id', () => {
    expect(getRecipe('does-not-exist')).toBeUndefined();
  });

  it('every question id within a recipe is unique', () => {
    for (const r of allRecipes) {
      const ids = r.questions.map((q) => q.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    }
  });

  describe('copilot-studio-field-service', () => {
    it('targets copilot-studio and asks for dynamicsOrgUrl', () => {
      expect(copilotStudioFieldService.target).toBe('copilot-studio');
      const q = copilotStudioFieldService.questions.find((x) => x.id === 'dynamicsOrgUrl');
      expect(q).toBeDefined();
      expect(q?.kind).toBe('url');
      expect(q?.required).toBe(true);
    });

    it('defaults channels to ["teams","web"]', () => {
      const ch = copilotStudioFieldService.questions.find((x) => x.id === 'channels');
      expect(ch?.default).toEqual(['teams', 'web']);
    });
  });

  describe('teams-tab-basic', () => {
    it('targets teams and adds tabRoute with default "/"', () => {
      expect(teamsTabBasic.target).toBe('teams');
      const q = teamsTabBasic.questions.find((x) => x.id === 'tabRoute');
      expect(q).toBeDefined();
      expect(q?.default).toBe('/');
    });
  });

  describe('teams-message-extension', () => {
    it('targets teams and adds meCommandId', () => {
      expect(teamsMessageExtension.target).toBe('teams');
      const q = teamsMessageExtension.questions.find((x) => x.id === 'meCommandId');
      expect(q).toBeDefined();
      expect(q?.kind).toBe('text');
    });
  });

  describe('teams-agent-365', () => {
    it('targets teams and asks the m365CopilotEnabled boolean', () => {
      expect(teamsAgent365.target).toBe('teams');
      const q = teamsAgent365.questions.find((x) => x.id === 'm365CopilotEnabled');
      expect(q).toBeDefined();
      expect(q?.kind).toBe('boolean');
    });

    it('has a kbSourcesAgent365 boolean defaulting to true', () => {
      const q = teamsAgent365.questions.find((x) => x.id === 'kbSourcesAgent365');
      expect(q).toBeDefined();
      expect(q?.kind).toBe('boolean');
      expect(q?.default).toBe(true);
    });
  });

  describe('legacy recipes remain intact', () => {
    it('copilot-studio-support-bot still has its original questions', () => {
      expect(copilotStudioSupportBot.questions.map((q) => q.id)).toEqual([
        'name',
        'purpose',
        'audience',
        'environment',
        'kbSources',
        'logoPath',
        'channels',
      ]);
    });

    it('teams-bot-basic still has its original questions', () => {
      expect(teamsBotBasic.questions.map((q) => q.id)).toEqual([
        'name',
        'purpose',
        'subscription',
        'resourceGroup',
        'region',
        'logoPath',
        'capabilities',
      ]);
    });
  });
});
