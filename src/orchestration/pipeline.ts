// Pipeline orchestration for multi-host AI workflows

import { EventEmitter } from 'events';
import { RemoteClient, RemoteClientManager, RemotePromptResult } from './remote-client.js';

export type StepResult = {
  stepId: string;
  stepName: string;
  status: 'completed' | 'error' | 'skipped';
  output?: string;
  error?: string;
  host?: string;
  startTime: string;
  endTime: string;
  latency: number;
};

export type PipelineResult = {
  pipelineId: string;
  status: 'completed' | 'error' | 'partial';
  steps: StepResult[];
  finalOutput?: string;
  startTime: string;
  endTime: string;
  totalLatency: number;
};

// Transform function type for modifying output between steps
export type TransformFn = (output: string, context: PipelineContext) => string | Promise<string>;

// Condition function type for conditional execution
export type ConditionFn = (context: PipelineContext) => boolean | Promise<boolean>;

export interface PipelineContext {
  pipelineId: string;
  variables: Record<string, string>;
  stepResults: Map<string, StepResult>;
  lastOutput?: string;
}

// Base step interface
export interface PipelineStep {
  id: string;
  name: string;
  type: 'prompt' | 'parallel' | 'conditional' | 'transform' | 'aggregate';
}

// Prompt step - sends a prompt to a host
export interface PromptStep extends PipelineStep {
  type: 'prompt';
  hostId?: string;  // If not specified, use next healthy host
  sessionId?: string;  // If not specified, create new session
  prompt: string | ((context: PipelineContext) => string);
  transform?: TransformFn;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

// Parallel step - executes multiple steps in parallel
export interface ParallelStep extends PipelineStep {
  type: 'parallel';
  steps: PipelineStep[];
  waitForAll?: boolean;  // Wait for all to complete, or return on first success
  aggregator?: (results: StepResult[]) => string;
}

// Conditional step - executes based on condition
export interface ConditionalStep extends PipelineStep {
  type: 'conditional';
  condition: ConditionFn;
  ifTrue: PipelineStep;
  ifFalse?: PipelineStep;
}

// Transform step - transforms the output
export interface TransformStep extends PipelineStep {
  type: 'transform';
  transform: TransformFn;
}

// Aggregate step - combines outputs from previous steps
export interface AggregateStep extends PipelineStep {
  type: 'aggregate';
  stepIds: string[];
  aggregator: (outputs: Map<string, string>) => string;
}

export type AnyPipelineStep = PromptStep | ParallelStep | ConditionalStep | TransformStep | AggregateStep;

export interface PipelineDefinition {
  id: string;
  name: string;
  description?: string;
  steps: AnyPipelineStep[];
  variables?: Record<string, string>;
  onError?: 'stop' | 'continue' | 'retry';
  maxRetries?: number;
}

export class PipelineExecutor extends EventEmitter {
  private clientManager: RemoteClientManager;
  private localClient?: RemoteClient;

  constructor(clientManager: RemoteClientManager, localClient?: RemoteClient) {
    super();
    this.clientManager = clientManager;
    this.localClient = localClient;
  }

  async execute(pipeline: PipelineDefinition): Promise<PipelineResult> {
    const startTime = new Date().toISOString();
    const context: PipelineContext = {
      pipelineId: pipeline.id,
      variables: { ...pipeline.variables },
      stepResults: new Map()
    };

    const results: StepResult[] = [];
    let finalOutput: string | undefined;
    let pipelineStatus: 'completed' | 'error' | 'partial' = 'completed';

    this.emit('pipeline.start', { pipelineId: pipeline.id, name: pipeline.name });

    for (const step of pipeline.steps) {
      try {
        const result = await this.executeStep(step, context);
        results.push(result);
        context.stepResults.set(step.id, result);

        if (result.output) {
          context.lastOutput = result.output;
          finalOutput = result.output;
        }

        this.emit('step.complete', { pipelineId: pipeline.id, step: result });

        if (result.status === 'error') {
          if (pipeline.onError === 'stop') {
            pipelineStatus = 'error';
            break;
          } else if (pipeline.onError === 'continue') {
            pipelineStatus = 'partial';
          }
        }
      } catch (error) {
        const errorResult: StepResult = {
          stepId: step.id,
          stepName: step.name,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          latency: 0
        };
        results.push(errorResult);
        context.stepResults.set(step.id, errorResult);

        this.emit('step.error', { pipelineId: pipeline.id, step: errorResult });

        if (pipeline.onError === 'stop') {
          pipelineStatus = 'error';
          break;
        }
        pipelineStatus = 'partial';
      }
    }

    const endTime = new Date().toISOString();
    const totalLatency = new Date(endTime).getTime() - new Date(startTime).getTime();

    const pipelineResult: PipelineResult = {
      pipelineId: pipeline.id,
      status: pipelineStatus,
      steps: results,
      finalOutput,
      startTime,
      endTime,
      totalLatency
    };

    this.emit('pipeline.complete', pipelineResult);

    return pipelineResult;
  }

  private async executeStep(step: AnyPipelineStep, context: PipelineContext): Promise<StepResult> {
    const startTime = new Date().toISOString();

    switch (step.type) {
      case 'prompt':
        return this.executePromptStep(step, context, startTime);
      case 'parallel':
        return this.executeParallelStep(step, context, startTime);
      case 'conditional':
        return this.executeConditionalStep(step, context, startTime);
      case 'transform':
        return this.executeTransformStep(step, context, startTime);
      case 'aggregate':
        return this.executeAggregateStep(step, context, startTime);
      default:
        throw new Error(`Unknown step type: ${(step as PipelineStep).type}`);
    }
  }

  private async executePromptStep(
    step: PromptStep,
    context: PipelineContext,
    startTime: string
  ): Promise<StepResult> {
    // Get the client
    let client: RemoteClient | undefined;
    if (step.hostId) {
      client = this.clientManager.getClient(step.hostId);
    } else if (this.localClient) {
      client = this.localClient;
    } else {
      client = this.clientManager.getNextHealthyHost();
    }

    if (!client) {
      return {
        stepId: step.id,
        stepName: step.name,
        status: 'error',
        error: 'No healthy host available',
        startTime,
        endTime: new Date().toISOString(),
        latency: 0
      };
    }

    // Resolve prompt (can be a function)
    const prompt = typeof step.prompt === 'function'
      ? step.prompt(context)
      : this.interpolateVariables(step.prompt, context);

    // Execute with retries
    let lastError: string | undefined;
    const retries = step.retries || 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Get or create session
        let sessionId = step.sessionId;
        if (!sessionId) {
          const session = await client.createSession();
          sessionId = session.id;
        }

        // Send prompt
        const result = await client.sendPrompt(sessionId, prompt, {
          timeout: step.timeout
        });

        if (result.status === 'completed') {
          let output = result.output || '';

          // Apply transform if specified
          if (step.transform && output) {
            output = await step.transform(output, context);
          }

          return {
            stepId: step.id,
            stepName: step.name,
            status: 'completed',
            output,
            host: result.host,
            startTime,
            endTime: new Date().toISOString(),
            latency: result.latency
          };
        }

        lastError = result.error || 'Unknown error';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      // Wait before retry
      if (attempt < retries && step.retryDelay) {
        await new Promise(resolve => setTimeout(resolve, step.retryDelay));
      }
    }

    return {
      stepId: step.id,
      stepName: step.name,
      status: 'error',
      error: lastError,
      host: client.getStatus().id,
      startTime,
      endTime: new Date().toISOString(),
      latency: new Date().getTime() - new Date(startTime).getTime()
    };
  }

  private async executeParallelStep(
    step: ParallelStep,
    context: PipelineContext,
    startTime: string
  ): Promise<StepResult> {
    const promises = step.steps.map(s => this.executeStep(s, context));

    let results: StepResult[];
    if (step.waitForAll !== false) {
      results = await Promise.all(promises);
    } else {
      // Return on first success
      results = await Promise.race([
        Promise.all(promises),
        new Promise<StepResult[]>((resolve) => {
          promises.forEach(async (p, i) => {
            const result = await p;
            if (result.status === 'completed') {
              resolve([result]);
            }
          });
        })
      ]);
    }

    // Store individual results
    for (const result of results) {
      context.stepResults.set(result.stepId, result);
    }

    // Aggregate results
    let output: string | undefined;
    if (step.aggregator) {
      output = step.aggregator(results);
    } else {
      // Default: concatenate successful outputs
      output = results
        .filter(r => r.status === 'completed' && r.output)
        .map(r => r.output)
        .join('\n\n---\n\n');
    }

    const hasErrors = results.some(r => r.status === 'error');
    const allErrors = results.every(r => r.status === 'error');

    return {
      stepId: step.id,
      stepName: step.name,
      status: allErrors ? 'error' : hasErrors ? 'completed' : 'completed',
      output,
      error: allErrors ? 'All parallel steps failed' : undefined,
      startTime,
      endTime: new Date().toISOString(),
      latency: new Date().getTime() - new Date(startTime).getTime()
    };
  }

  private async executeConditionalStep(
    step: ConditionalStep,
    context: PipelineContext,
    startTime: string
  ): Promise<StepResult> {
    const condition = await step.condition(context);

    const stepToExecute = condition ? step.ifTrue : step.ifFalse;

    if (!stepToExecute) {
      return {
        stepId: step.id,
        stepName: step.name,
        status: 'skipped',
        startTime,
        endTime: new Date().toISOString(),
        latency: 0
      };
    }

    const result = await this.executeStep(stepToExecute, context);

    return {
      stepId: step.id,
      stepName: step.name,
      status: result.status,
      output: result.output,
      error: result.error,
      host: result.host,
      startTime,
      endTime: new Date().toISOString(),
      latency: new Date().getTime() - new Date(startTime).getTime()
    };
  }

  private async executeTransformStep(
    step: TransformStep,
    context: PipelineContext,
    startTime: string
  ): Promise<StepResult> {
    if (!context.lastOutput) {
      return {
        stepId: step.id,
        stepName: step.name,
        status: 'error',
        error: 'No previous output to transform',
        startTime,
        endTime: new Date().toISOString(),
        latency: 0
      };
    }

    try {
      const output = await step.transform(context.lastOutput, context);

      return {
        stepId: step.id,
        stepName: step.name,
        status: 'completed',
        output,
        startTime,
        endTime: new Date().toISOString(),
        latency: new Date().getTime() - new Date(startTime).getTime()
      };
    } catch (error) {
      return {
        stepId: step.id,
        stepName: step.name,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        startTime,
        endTime: new Date().toISOString(),
        latency: new Date().getTime() - new Date(startTime).getTime()
      };
    }
  }

  private async executeAggregateStep(
    step: AggregateStep,
    context: PipelineContext,
    startTime: string
  ): Promise<StepResult> {
    const outputs = new Map<string, string>();

    for (const stepId of step.stepIds) {
      const result = context.stepResults.get(stepId);
      if (result?.output) {
        outputs.set(stepId, result.output);
      }
    }

    if (outputs.size === 0) {
      return {
        stepId: step.id,
        stepName: step.name,
        status: 'error',
        error: 'No outputs to aggregate',
        startTime,
        endTime: new Date().toISOString(),
        latency: 0
      };
    }

    try {
      const output = step.aggregator(outputs);

      return {
        stepId: step.id,
        stepName: step.name,
        status: 'completed',
        output,
        startTime,
        endTime: new Date().toISOString(),
        latency: new Date().getTime() - new Date(startTime).getTime()
      };
    } catch (error) {
      return {
        stepId: step.id,
        stepName: step.name,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        startTime,
        endTime: new Date().toISOString(),
        latency: new Date().getTime() - new Date(startTime).getTime()
      };
    }
  }

  private interpolateVariables(template: string, context: PipelineContext): string {
    let result = template;

    // Replace ${varName} with variable values
    for (const [key, value] of Object.entries(context.variables)) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }

    // Replace ${steps.stepId.output} with step outputs
    const stepOutputPattern = /\$\{steps\.(\w+)\.output\}/g;
    result = result.replace(stepOutputPattern, (_, stepId) => {
      const stepResult = context.stepResults.get(stepId);
      return stepResult?.output || '';
    });

    // Replace ${lastOutput} with last output
    result = result.replace(/\$\{lastOutput\}/g, context.lastOutput || '');

    return result;
  }
}

// Helper functions for creating pipeline steps
export function promptStep(config: Omit<PromptStep, 'type'>): PromptStep {
  return { ...config, type: 'prompt' };
}

export function parallelStep(config: Omit<ParallelStep, 'type'>): ParallelStep {
  return { ...config, type: 'parallel' };
}

export function conditionalStep(config: Omit<ConditionalStep, 'type'>): ConditionalStep {
  return { ...config, type: 'conditional' };
}

export function transformStep(config: Omit<TransformStep, 'type'>): TransformStep {
  return { ...config, type: 'transform' };
}

export function aggregateStep(config: Omit<AggregateStep, 'type'>): AggregateStep {
  return { ...config, type: 'aggregate' };
}
