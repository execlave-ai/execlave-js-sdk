import { Agent } from '../agent';
import type { AgentData } from '../types';

/** Helper to build a mock client reference. */
function createMockClient() {
  return {
    _request: jest.fn(),
    _apiPath: (path: string) => `/api/v1${path}`,
  };
}

/** Helper to build minimal agent data. */
function agentData(overrides: Partial<AgentData> = {}): AgentData {
  return {
    id: 'uuid-1',
    agentId: 'my-bot',
    name: 'My Bot',
    environment: 'production',
    status: 'active',
    ...overrides,
  };
}

describe('Agent', () => {
  // ------------------------------------------------------------------
  // Construction & properties
  // ------------------------------------------------------------------
  describe('constructor', () => {
    it('should expose id, agentId, name, environment, status', () => {
      const client = createMockClient();
      const agent = new Agent(client, agentData());

      expect(agent.id).toBe('uuid-1');
      expect(agent.agentId).toBe('my-bot');
      expect(agent.name).toBe('My Bot');
      expect(agent.environment).toBe('production');
      expect(agent.status).toBe('active');
    });
  });

  // ------------------------------------------------------------------
  // isPaused
  // ------------------------------------------------------------------
  describe('isPaused', () => {
    it('should return false when status is active', () => {
      const client = createMockClient();
      const agent = new Agent(client, agentData({ status: 'active' }));
      expect(agent.isPaused).toBe(false);
    });

    it('should return true when status is paused', () => {
      const client = createMockClient();
      const agent = new Agent(client, agentData({ status: 'paused' }));
      expect(agent.isPaused).toBe(true);
    });

    it('should reflect runtime status changes', () => {
      const client = createMockClient();
      const agent = new Agent(client, agentData({ status: 'active' }));
      expect(agent.isPaused).toBe(false);
      agent.status = 'paused';
      expect(agent.isPaused).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // refreshStatus
  // ------------------------------------------------------------------
  describe('refreshStatus()', () => {
    it('should fetch status from API and update agent', async () => {
      const client = createMockClient();
      client._request.mockResolvedValue({ data: { status: 'paused' } });
      const agent = new Agent(client, agentData());

      const result = await agent.refreshStatus();

      expect(client._request).toHaveBeenCalledWith('GET', '/api/v1/agents/uuid-1/status-poll');
      expect(result).toBe('paused');
      expect(agent.status).toBe('paused');
    });

    it('should keep existing status when API returns no status field', async () => {
      const client = createMockClient();
      client._request.mockResolvedValue({ data: {} });
      const agent = new Agent(client, agentData({ status: 'active' }));

      const result = await agent.refreshStatus();
      expect(result).toBe('active');
    });
  });

  // ------------------------------------------------------------------
  // rollbackToVersion
  // ------------------------------------------------------------------
  describe('rollbackToVersion()', () => {
    it('should find the target version and POST a rollback', async () => {
      const client = createMockClient();
      const versions = [
        { id: 'v1', versionNumber: 1 },
        { id: 'v2', versionNumber: 2 },
        { id: 'v3', versionNumber: 3 },
      ];
      // listPromptVersions call
      client._request.mockResolvedValueOnce({ data: versions });
      // rollback call
      client._request.mockResolvedValueOnce({
        data: { id: 'v2', versionNumber: 2, isDeployed: true },
      });

      const agent = new Agent(client, agentData());
      const result = await agent.rollbackToVersion(2, 'regression detected');

      expect(client._request).toHaveBeenCalledTimes(2);
      expect(client._request).toHaveBeenNthCalledWith(
        2,
        'POST',
        '/api/v1/prompt-versions/v2/rollback',
        { reason: 'regression detected' },
      );
      expect(result.id).toBe('v2');
    });

    it('should throw if the target version does not exist', async () => {
      const client = createMockClient();
      client._request.mockResolvedValueOnce({ data: [{ id: 'v1', versionNumber: 1 }] });

      const agent = new Agent(client, agentData());
      await expect(agent.rollbackToVersion(99, 'reason')).rejects.toThrow(
        'Prompt version 99 not found for agent my-bot',
      );
    });
  });

  // ------------------------------------------------------------------
  // promoteToProduction
  // ------------------------------------------------------------------
  describe('promoteToProduction()', () => {
    it('should POST deploy with production environment', async () => {
      const client = createMockClient();
      client._request.mockResolvedValue({
        data: { id: 'v1', environment: 'production', isDeployed: true },
      });

      const agent = new Agent(client, agentData());
      const result = await agent.promoteToProduction('v1', {
        requireApproval: false,
        deploymentNotes: 'hotfix',
      });

      expect(client._request).toHaveBeenCalledWith('POST', '/api/v1/prompt-versions/v1/deploy', {
        environment: 'production',
        requireApproval: false,
        deploymentNotes: 'hotfix',
      });
      expect(result.id).toBe('v1');
    });

    it('should use defaults when opts are omitted', async () => {
      const client = createMockClient();
      client._request.mockResolvedValue({ data: { id: 'v2' } });

      const agent = new Agent(client, agentData());
      await agent.promoteToProduction('v2');

      expect(client._request).toHaveBeenCalledWith('POST', '/api/v1/prompt-versions/v2/deploy', {
        environment: 'production',
        requireApproval: true,
        deploymentNotes: null,
      });
    });
  });

  // ------------------------------------------------------------------
  // deployPrompt
  // ------------------------------------------------------------------
  describe('deployPrompt()', () => {
    it('should POST prompt version payload', async () => {
      const client = createMockClient();
      client._request.mockResolvedValue({
        data: { id: 'pv-1', versionNumber: 1, isDeployed: false },
      });

      const agent = new Agent(client, agentData());
      const result = await agent.deployPrompt({
        promptTemplate: 'You are a helpful assistant.',
        changeType: 'major',
        changeDescription: 'initial prompt',
      });

      expect(client._request).toHaveBeenCalledWith(
        'POST',
        '/api/v1/prompt-versions',
        expect.objectContaining({
          agentId: 'uuid-1',
          promptTemplate: 'You are a helpful assistant.',
          changeSummary: 'initial prompt',
        }),
      );
      expect(result.id).toBe('pv-1');
    });
  });

  // ------------------------------------------------------------------
  // getCurrentPrompt
  // ------------------------------------------------------------------
  describe('getCurrentPrompt()', () => {
    it('should return the deployed version', async () => {
      const client = createMockClient();
      client._request.mockResolvedValue({
        data: [
          { id: 'v1', isDeployed: false },
          { id: 'v2', isDeployed: true },
        ],
      });

      const agent = new Agent(client, agentData());
      const result = await agent.getCurrentPrompt();
      expect(result?.id).toBe('v2');
    });

    it('should return null when no version is deployed', async () => {
      const client = createMockClient();
      client._request.mockResolvedValue({
        data: [{ id: 'v1', isDeployed: false }],
      });

      const agent = new Agent(client, agentData());
      const result = await agent.getCurrentPrompt();
      expect(result).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // toJSON
  // ------------------------------------------------------------------
  describe('toJSON()', () => {
    it('should return a copy of the data with current status', () => {
      const client = createMockClient();
      const data = agentData({ status: 'active' });
      const agent = new Agent(client, data);
      agent.status = 'paused';

      const json = agent.toJSON();
      expect(json.status).toBe('paused');
      // Should be a copy
      expect(json).not.toBe(data);
    });
  });
});
