/**
 * Agent object returned from `ag.registerAgent()`.
 *
 * Provides prompt management methods and exposes agent metadata.
 */

import type { AgentData, AgentStatus, DeployPromptOptions, PromptVersionData } from './types';

/** Back-reference interface — avoids circular imports. */
interface ClientRef {
  _request(method: string, path: string, body?: unknown): Promise<any>;
  _apiPath(path: string): string;
}

export class Agent {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly environment: string;
  status: string;

  private _client: ClientRef;
  private _data: AgentData;

  constructor(client: ClientRef, data: AgentData) {
    this._client = client;
    this._data = data;
    this.id = data.id;
    this.agentId = data.agentId;
    this.name = data.name;
    this.environment = data.environment;
    this.status = data.status;
  }

  /** Whether this agent is currently paused via the kill switch. */
  get isPaused(): boolean {
    return this.status === 'paused';
  }

  /**
   * Deploy a new prompt version for this agent.
   *
   * @returns The created PromptVersion metadata.
   */
  async deployPrompt(opts: DeployPromptOptions): Promise<PromptVersionData> {
    const params = opts.modelParameters ?? {};
    const payload: Record<string, unknown> = {
      agentId: this.id,
      promptTemplate: opts.promptTemplate,
      systemMessage: opts.systemMessage ?? null,
      modelName: opts.modelName ?? null,
      temperature: params.temperature ?? null,
      maxTokens: params.max_tokens ?? params.maxTokens ?? null,
      // Backend schema uses 'changeSummary' not 'changeType'
      changeSummary: opts.changeDescription ?? opts.changeType ?? null,
      versionTag: opts.versionTag ?? null,
      notes: opts.changeDescription ?? null,
    };

    const resp = await this._client._request('POST', this._client._apiPath('/prompt-versions'), payload);
    return resp.data as PromptVersionData;
  }

  /**
   * Get the currently deployed prompt version for this agent.
   *
   * @returns PromptVersionData or null if no version is deployed.
   */
  async getCurrentPrompt(): Promise<PromptVersionData | null> {
    const resp = await this._client._request(
      'GET',
      `${this._client._apiPath('/prompt-versions')}?agentId=${encodeURIComponent(this.id)}&deployed=true`
    );
    const versions = resp.data as PromptVersionData[];
    return versions.find((v) => v.isDeployed) ?? null;
  }

  /**
   * List all prompt versions for this agent.
   */
  async listPromptVersions(): Promise<PromptVersionData[]> {
    const resp = await this._client._request(
      'GET',
      `${this._client._apiPath('/prompt-versions')}?agentId=${encodeURIComponent(this.id)}`
    );
    return resp.data as PromptVersionData[];
  }

  /** Refresh agent status from the API. */
  async refreshStatus(): Promise<string> {
    const resp = await this._client._request('GET', this._client._apiPath(`/agents/${this.id}/status-poll`));
    this.status = resp.data?.status ?? this.status;
    return this.status;
  }

  /**
   * Rollback to a specific prompt version.
   *
   * @param versionNumber - The version number to rollback to.
   * @param reason        - Required reason for the rollback.
   * @returns The activated PromptVersionData.
   */
  async rollbackToVersion(versionNumber: number, reason: string): Promise<PromptVersionData> {
    const versions = await this.listPromptVersions();
    const target = versions.find((v) => v.versionNumber === versionNumber);
    if (!target) {
      throw new Error(`Prompt version ${versionNumber} not found for agent ${this.agentId}`);
    }
    const resp = await this._client._request('POST', this._client._apiPath(`/prompt-versions/${target.id}/rollback`), {
      reason,
    });
    return resp.data as PromptVersionData;
  }

  /**
   * Promote a staging prompt version to production.
   *
   * @param versionId       - The version ID to promote.
   * @param requireApproval - Whether to require admin approval.
   * @param deploymentNotes - Notes for the deployment.
   * @returns The promoted PromptVersionData.
   */
  async promoteToProduction(
    versionId: string,
    opts?: { requireApproval?: boolean; deploymentNotes?: string }
  ): Promise<PromptVersionData> {
    const resp = await this._client._request('POST', this._client._apiPath(`/prompt-versions/${versionId}/deploy`), {
      environment: 'production',
      requireApproval: opts?.requireApproval ?? true,
      deploymentNotes: opts?.deploymentNotes ?? null,
    });
    return resp.data as PromptVersionData;
  }

  /** Return raw agent data. */
  toJSON(): AgentData {
    return { ...this._data, status: this.status as AgentStatus };
  }
}
