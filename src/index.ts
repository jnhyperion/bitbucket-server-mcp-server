#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import winston from 'winston';

// Configuration du logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'bitbucket.log' })
  ]
});

interface BitbucketActivity {
  action: string;
  [key: string]: unknown;
}

interface BitbucketConfig {
  baseUrl: string;
  token?: string;
  username?: string;
  password?: string;
  defaultProject?: string;
}

interface RepositoryParams {
  project?: string;
  repository?: string;
}

interface PullRequestParams extends RepositoryParams {
  prId?: number;
}

interface MergeOptions {
  message?: string;
  strategy?: 'merge-commit' | 'squash' | 'fast-forward';
}

interface CommentOptions {
  text: string;
  parentId?: number;
}

interface PullRequestInput extends RepositoryParams {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  reviewers?: string[];
}

interface ListOptions {
  limit?: number;
  start?: number;
}

interface ListRepositoriesOptions extends ListOptions {
  project?: string;
}

class BitbucketServer {
  private readonly server: Server;
  private readonly api: AxiosInstance;
  private readonly config: BitbucketConfig;

  constructor() {
    this.server = new Server(
      {
        name: 'bitbucket-server-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Configuration initiale à partir des variables d'environnement
    this.config = {
      baseUrl: process.env.BITBUCKET_URL ?? '',
      token: process.env.BITBUCKET_TOKEN,
      username: process.env.BITBUCKET_USERNAME,
      password: process.env.BITBUCKET_PASSWORD,
      defaultProject: process.env.BITBUCKET_DEFAULT_PROJECT
    };

    if (!this.config.baseUrl) {
      throw new Error('BITBUCKET_URL is required');
    }

    if (!this.config.token && !(this.config.username && this.config.password)) {
      throw new Error('Either BITBUCKET_TOKEN or BITBUCKET_USERNAME/PASSWORD is required');
    }

    // Configuration de l'instance Axios
    this.api = axios.create({
      baseURL: `${this.config.baseUrl}/rest/api/1.0`,
      headers: this.config.token 
        ? { Authorization: `Bearer ${this.config.token}` }
        : {},
      auth: this.config.username && this.config.password
        ? { username: this.config.username, password: this.config.password }
        : undefined,
    });

    this.setupToolHandlers();
    
    this.server.onerror = (error) => logger.error('[MCP Error]', error);
  }

  private isPullRequestInput(args: unknown): args is PullRequestInput {
    const input = args as Partial<PullRequestInput>;
    return typeof args === 'object' &&
      args !== null &&
      typeof input.project === 'string' &&
      typeof input.repository === 'string' &&
      typeof input.title === 'string' &&
      typeof input.sourceBranch === 'string' &&
      typeof input.targetBranch === 'string' &&
      (input.description === undefined || typeof input.description === 'string') &&
      (input.reviewers === undefined || Array.isArray(input.reviewers));
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_projects',
          description: 'Discover and list all Bitbucket projects you have access to. Use this first to explore available projects, find project keys, or when you need to work with a specific project but don\'t know its exact key. Returns project keys, names, descriptions and visibility settings.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Number of projects to return (default: 25, max: 1000)' },
              start: { type: 'number', description: 'Start index for pagination (default: 0)' }
            }
          }
        },
        {
          name: 'list_repositories',
          description: 'Browse and discover repositories within a specific project or across all accessible projects. Use this to find repository slugs, explore codebases, or understand the repository structure. Returns repository names, slugs, clone URLs, and project associations.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key to list repositories from. If omitted, uses BITBUCKET_DEFAULT_PROJECT or lists all accessible repositories across projects.' },
              limit: { type: 'number', description: 'Number of repositories to return (default: 25, max: 1000)' },
              start: { type: 'number', description: 'Start index for pagination (default: 0)' }
            }
          }
        },
        {
          name: 'create_pull_request',
          description: 'Create a new pull request to propose code changes, request reviews, or merge feature branches. Use this when you want to submit code for review, merge a feature branch, or contribute changes to a repository. Automatically sets up branch references and can assign reviewers.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable. Use list_projects to discover available projects.' },
              repository: { type: 'string', description: 'Repository slug where the pull request will be created. Use list_repositories to find available repositories.' },
              title: { type: 'string', description: 'Clear, descriptive title for the pull request that summarizes the changes.' },
              description: { type: 'string', description: 'Detailed description of changes, context, and any relevant information for reviewers. Supports Markdown formatting.' },
              sourceBranch: { type: 'string', description: 'Source branch name containing the changes to be merged (e.g., "feature/new-login", "bugfix/security-patch").' },
              targetBranch: { type: 'string', description: 'Target branch where changes will be merged (e.g., "main", "develop", "release/v1.2").' },
              reviewers: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of Bitbucket usernames to assign as reviewers for this pull request.'
              }
            },
            required: ['repository', 'title', 'sourceBranch', 'targetBranch']
          }
        },
        {
          name: 'get_pull_request',
          description: 'Retrieve comprehensive details about a specific pull request including status, reviewers, commits, and metadata. Use this to check PR status, review progress, understand changes, or gather information before performing actions like merging or commenting.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Unique pull request ID number (e.g., 123, 456).' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'merge_pull_request',
          description: 'Merge an approved pull request into the target branch. Use this when a PR has been reviewed, approved, and is ready to be integrated. Choose the appropriate merge strategy based on your team\'s workflow and repository history preferences.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to merge.' },
              message: { type: 'string', description: 'Custom merge commit message. If not provided, uses default merge message format.' },
              strategy: {
                type: 'string',
                enum: ['merge-commit', 'squash', 'fast-forward'],
                description: 'Merge strategy: "merge-commit" creates a merge commit preserving branch history, "squash" combines all commits into one, "fast-forward" moves the branch pointer without creating a merge commit.'
              }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'decline_pull_request',
          description: 'Decline or reject a pull request that should not be merged. Use this when changes are not acceptable, conflicts with project direction, or when the PR needs significant rework. This closes the PR without merging.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to decline.' },
              message: { type: 'string', description: 'Reason for declining the pull request. Helps the author understand why it was rejected.' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'add_comment',
          description: 'Add a comment to a pull request for code review, feedback, questions, or discussion. Use this to provide review feedback, ask questions about specific changes, suggest improvements, or participate in code review discussions. Supports threaded conversations.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to comment on.' },
              text: { type: 'string', description: 'Comment text content. Supports Markdown formatting for code blocks, links, and emphasis.' },
              parentId: { type: 'number', description: 'ID of parent comment to reply to. Omit for top-level comments.' }
            },
            required: ['repository', 'prId', 'text']
          }
        },
        {
          name: 'get_diff',
          description: 'Retrieve the code differences (diff) for a pull request showing what lines were added, removed, or modified. Use this to understand the scope of changes, review specific code modifications, or analyze the impact of proposed changes before merging.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get diff for.' },
              contextLines: { type: 'number', description: 'Number of context lines to show around changes (default: 10). Higher values provide more surrounding code context.' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'get_reviews',
          description: 'Fetch the review history and approval status of a pull request. Use this to check who has reviewed the PR, see approval status, understand review feedback, or determine if the PR is ready for merging based on review requirements.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get reviews for.' }
            },
            required: ['repository', 'prId']
          }
        },
        {
          name: 'get_activities',
          description: 'Retrieve all activities for a pull request including comments, reviews, commits, and other timeline events. Use this to get the complete activity history and timeline of the pull request.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Bitbucket project key. If omitted, uses BITBUCKET_DEFAULT_PROJECT environment variable.' },
              repository: { type: 'string', description: 'Repository slug containing the pull request.' },
              prId: { type: 'number', description: 'Pull request ID to get activities for.' }
            },
            required: ['repository', 'prId']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        logger.info(`Called tool: ${request.params.name}`, { arguments: request.params.arguments });
        const args = request.params.arguments ?? {};

        // Helper function to get project with fallback to default
        const getProject = (providedProject?: string): string => {
          const project = providedProject || this.config.defaultProject;
          if (!project) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Project must be provided either as a parameter or through BITBUCKET_DEFAULT_PROJECT environment variable'
            );
          }
          return project;
        };

        switch (request.params.name) {
          case 'list_projects': {
            return await this.listProjects({
              limit: args.limit as number,
              start: args.start as number
            });
          }

          case 'list_repositories': {
            return await this.listRepositories({
              project: args.project as string,
              limit: args.limit as number,
              start: args.start as number
            });
          }

          case 'create_pull_request': {
            if (!this.isPullRequestInput(args)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Invalid pull request input parameters'
              );
            }
            // Ensure project is set
            const createArgs = { ...args, project: getProject(args.project) };
            return await this.createPullRequest(createArgs);
          }

          case 'get_pull_request': {
            const getPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getPullRequest(getPrParams);
          }

          case 'merge_pull_request': {
            const mergePrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.mergePullRequest(mergePrParams, {
              message: args.message as string,
              strategy: args.strategy as 'merge-commit' | 'squash' | 'fast-forward'
            });
          }

          case 'decline_pull_request': {
            const declinePrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.declinePullRequest(declinePrParams, args.message as string);
          }

          case 'add_comment': {
            const commentPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.addComment(commentPrParams, {
              text: args.text as string,
              parentId: args.parentId as number
            });
          }

          case 'get_diff': {
            const diffPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getDiff(diffPrParams, args.contextLines as number);
          }

          case 'get_reviews': {
            const reviewsPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getReviews(reviewsPrParams);
          }

          case 'get_activities': {
            const activitiesPrParams: PullRequestParams = {
              project: getProject(args.project as string),
              repository: args.repository as string,
              prId: args.prId as number
            };
            return await this.getActivities(activitiesPrParams);
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        logger.error('Tool execution error', { error });
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Bitbucket API error: ${error.response?.data.message ?? error.message}`
          );
        }
        throw error;
      }
    });
  }

  private async listProjects(options: ListOptions = {}) {
    const { limit = 25, start = 0 } = options;
    const response = await this.api.get('/projects', {
      params: { limit, start }
    });

    const projects = response.data.values || [];
    const summary = {
      total: response.data.size || projects.length,
      showing: projects.length,
      projects: projects.map((project: { key: string; name: string; description?: string; public: boolean; type: string }) => ({
        key: project.key,
        name: project.name,
        description: project.description,
        public: project.public,
        type: project.type
      }))
    };

    return {
      content: [{ 
        type: 'text', 
        text: JSON.stringify(summary, null, 2) 
      }]
    };
  }

  private async listRepositories(options: ListRepositoriesOptions = {}) {
    const { project, limit = 25, start = 0 } = options;
    
    let endpoint: string;
    const params = { limit, start };

    if (project || this.config.defaultProject) {
      // List repositories for a specific project
      const projectKey = project || this.config.defaultProject;
      endpoint = `/projects/${projectKey}/repos`;
    } else {
      // List all accessible repositories
      endpoint = '/repos';
    }

    const response = await this.api.get(endpoint, { params });

    const repositories = response.data.values || [];
    const summary = {
      project: project || this.config.defaultProject || 'all',
      total: response.data.size || repositories.length,
      showing: repositories.length,
      repositories: repositories.map((repo: { 
        slug: string; 
        name: string; 
        description?: string; 
        project?: { key: string }; 
        public: boolean; 
        links?: { clone?: { name: string; href: string }[] }; 
        state: string 
      }) => ({
        slug: repo.slug,
        name: repo.name,
        description: repo.description,
        project: repo.project?.key,
        public: repo.public,
        cloneUrl: repo.links?.clone?.find((link: { name: string; href: string }) => link.name === 'http')?.href,
        state: repo.state
      }))
    };

    return {
      content: [{ 
        type: 'text', 
        text: JSON.stringify(summary, null, 2) 
      }]
    };
  }

  private async createPullRequest(input: PullRequestInput) {
    const response = await this.api.post(
      `/projects/${input.project}/repos/${input.repository}/pull-requests`,
      {
        title: input.title,
        description: input.description,
        fromRef: {
          id: `refs/heads/${input.sourceBranch}`,
          repository: {
            slug: input.repository,
            project: { key: input.project }
          }
        },
        toRef: {
          id: `refs/heads/${input.targetBranch}`,
          repository: {
            slug: input.repository,
            project: { key: input.project }
          }
        },
        reviewers: input.reviewers?.map(username => ({ user: { name: username } }))
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async getPullRequest(params: PullRequestParams) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}`
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async mergePullRequest(params: PullRequestParams, options: MergeOptions = {}) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const { message, strategy = 'merge-commit' } = options;
    
    const response = await this.api.post(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/merge`,
      {
        version: -1,
        message,
        strategy
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async declinePullRequest(params: PullRequestParams, message?: string) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.post(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/decline`,
      {
        version: -1,
        message
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async addComment(params: PullRequestParams, options: CommentOptions) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const { text, parentId } = options;
    
    const response = await this.api.post(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/comments`,
      {
        text,
        parent: parentId ? { id: parentId } : undefined
      }
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  private async getDiff(params: PullRequestParams, contextLines: number = 10) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/diff`,
      {
        params: { contextLines },
        headers: { Accept: 'text/plain' }
      }
    );

    return {
      content: [{ type: 'text', text: response.data }]
    };
  }

  private async getReviews(params: PullRequestParams) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/activities`
    );

    const reviews = response.data.values.filter(
      (activity: BitbucketActivity) => activity.action === 'APPROVED' || activity.action === 'REVIEWED'
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(reviews, null, 2) }]
    };
  }

  private async getActivities(params: PullRequestParams) {
    const { project, repository, prId } = params;
    
    if (!project || !repository || !prId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Project, repository, and prId are required'
      );
    }
    
    const response = await this.api.get(
      `/projects/${project}/repos/${repository}/pull-requests/${prId}/activities`
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Bitbucket MCP server running on stdio');
  }
}

const server = new BitbucketServer();
server.run().catch((error) => {
  logger.error('Server error', error);
  process.exit(1);
});