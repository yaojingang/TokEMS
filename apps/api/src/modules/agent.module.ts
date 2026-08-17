import type { FastifyRequest } from 'fastify';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  API_ERROR_CODES,
  TOKEMS_AGENT_API_VERSION,
  TOKEMS_AGENT_CATALOG_VERSION,
  TOKEMS_AGENT_MIN_CLIENT_VERSION,
  TOKEMS_AGENT_SKILL_VERSION,
} from '@conference/contracts';
import {
  normalizeAgentOrigin,
  resolveAgentAccessFeatures,
  resolveAgentResource,
} from '@conference/security';
import { AuthGuard, grantsAllowAll, type AuthenticatedUser } from '../common/auth.guard.js';
import { AgentAuthorizationService } from '../common/agent-authorization.service.js';
import { AGENT_ACTIONS, AgentExcluded, AgentSurface } from '../common/agent-operation-catalog.js';
import { AgentOperationService } from '../common/agent-operation.service.js';
import type { AgentPrincipal } from '../common/agent-principal.service.js';
import { DomainError } from '../common/domain-error.js';

type AgentRequest = FastifyRequest & {
  user?: AuthenticatedUser;
  agentPrincipal?: AgentPrincipal;
};

function requireAgent(request: AgentRequest) {
  if (!request.agentPrincipal || !request.user) {
    throw new DomainError(
      API_ERROR_CODES.UNAUTHORIZED,
      'This endpoint requires a TokEMS Agent connection',
      HttpStatus.UNAUTHORIZED,
    );
  }
  return { principal: request.agentPrincipal, user: request.user };
}

function requireHuman(request: AgentRequest) {
  if (request.agentPrincipal || !request.user) {
    throw new DomainError(
      API_ERROR_CODES.FORBIDDEN,
      'Agent tokens cannot approve connections or operations',
      HttpStatus.FORBIDDEN,
    );
  }
  return request.user;
}

@ApiTags('agent-discovery')
@Controller()
class AgentWellKnownController {
  @Get('.well-known/tokems-agent')
  metadata() {
    const resource = resolveAgentResource();
    const origin = new URL(resource).origin;
    const adminOrigin = normalizeAgentOrigin(
      process.env.ADMIN_ORIGIN ?? process.env.ADMIN_WEB_URL ?? origin,
    );
    return {
      issuer: origin,
      resource,
      adminOrigin,
      apiVersion: TOKEMS_AGENT_API_VERSION,
      catalogVersion: TOKEMS_AGENT_CATALOG_VERSION,
      skillPackageVersion: TOKEMS_AGENT_SKILL_VERSION,
      minClientVersion: TOKEMS_AGENT_MIN_CLIENT_VERSION,
      features: resolveAgentAccessFeatures(),
      authorizationEndpoint: `${resource}/oauth/device_authorization`,
      tokenEndpoint: `${resource}/oauth/token`,
      revocationEndpoint: `${resource}/oauth/revoke`,
      capabilitiesEndpoint: `${resource}/agent/capabilities`,
    };
  }

  @Get('.well-known/oauth-authorization-server')
  oauthMetadata() {
    const resource = resolveAgentResource();
    const origin = new URL(resource).origin;
    return {
      issuer: origin,
      device_authorization_endpoint: `${resource}/oauth/device_authorization`,
      token_endpoint: `${resource}/oauth/token`,
      revocation_endpoint: `${resource}/oauth/revoke`,
      grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      dpop_signing_alg_values_supported: ['ES256'],
      scopes_supported: [
        'tokems:read',
        'tokems:pii',
        'tokems:write',
        'tokems:finance',
        'tokems:communications',
        'tokems:export',
        'tokems:security',
        'tokems:dangerous',
        'tokems:*',
      ],
    };
  }
}

@ApiTags('agent-oauth')
@Controller('oauth')
class AgentOAuthController {
  constructor(
    @Inject(AgentAuthorizationService)
    private readonly authorization: AgentAuthorizationService,
  ) {}

  @Post('device_authorization')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  authorize(@Body() body: unknown) {
    return this.authorization.createDeviceAuthorization(body);
  }

  @Post('token')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  token(@Body() body: unknown, @Headers('dpop') proof: string | undefined) {
    const resource = resolveAgentResource();
    return this.authorization.exchangeDeviceCode({
      payload: body,
      proof,
      method: 'POST',
      url: `${new URL(resource).origin}/api/v1/oauth/token`,
    });
  }

  @Post('revoke')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  revoke(@Body() body: { token?: unknown }) {
    if (typeof body?.token !== 'string') return { revoked: true };
    return this.authorization.revokeByRefreshToken(body.token);
  }
}

@ApiTags('agent')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('agent')
class AgentController {
  constructor(@Inject(AgentOperationService) private readonly operations: AgentOperationService) {}

  @Get('capabilities')
  capabilities(@Req() request: AgentRequest) {
    const { principal, user } = requireAgent(request);
    const features = resolveAgentAccessFeatures();
    return {
      apiVersion: TOKEMS_AGENT_API_VERSION,
      catalogVersion: TOKEMS_AGENT_CATALOG_VERSION,
      skillPackageVersion: TOKEMS_AGENT_SKILL_VERSION,
      minClientVersion: TOKEMS_AGENT_MIN_CLIENT_VERSION,
      resource: resolveAgentResource(),
      adminOrigin: normalizeAgentOrigin(
        process.env.ADMIN_ORIGIN ??
          process.env.ADMIN_WEB_URL ??
          new URL(resolveAgentResource()).origin,
      ),
      organizationId: principal.organizationId,
      connectionId: principal.connectionId,
      features,
      scopes: principal.scopes,
      actions: AGENT_ACTIONS.filter(
        (action) =>
          grantsAllowAll(user.grants, action.requiredGrants) &&
          action.agentScopes.every((scope) => principal.scopes.includes(scope)) &&
          (action.method === 'GET' || features.writes) &&
          (action.riskBase !== 'critical' || features.criticalActions),
      ),
    };
  }

  @Post('operations')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  prepare(@Body() body: unknown, @Req() request: AgentRequest) {
    const { principal, user } = requireAgent(request);
    return this.operations.prepare(body, principal, user, String(request.id));
  }

  @Get('operations/:operationId')
  status(@Param('operationId') id: string, @Req() request: AgentRequest) {
    return this.operations.get(id, requireAgent(request).principal);
  }

  @Post('operations/:operationId/confirm')
  confirm(@Param('operationId') id: string, @Body() body: unknown, @Req() request: AgentRequest) {
    return this.operations.confirm(id, body, requireAgent(request).principal);
  }

  @Post('operations/:operationId/cancel')
  cancel(@Param('operationId') id: string, @Req() request: AgentRequest) {
    return this.operations.cancel(id, requireAgent(request).principal);
  }

  @Post('operations/:operationId/verify')
  verify(@Param('operationId') id: string, @Body() body: unknown, @Req() request: AgentRequest) {
    return this.operations.verify(id, body, requireAgent(request).principal, String(request.id));
  }

  @Get('operations/:operationId/one-time-secret')
  oneTimeSecret(@Param('operationId') id: string, @Req() request: AgentRequest) {
    return this.operations.readOneTimeSecret(id, requireAgent(request).principal);
  }

  @Post('operations/:operationId/one-time-secret/acknowledge')
  acknowledgeOneTimeSecret(@Param('operationId') id: string, @Req() request: AgentRequest) {
    return this.operations.acknowledgeOneTimeSecret(id, requireAgent(request).principal);
  }

  @Post('operations/:operationId/reconcile')
  reconcile(@Param('operationId') id: string, @Req() request: AgentRequest) {
    return this.operations.get(id, requireAgent(request).principal);
  }
}

@ApiTags('agent-human-approval')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@AgentSurface({ defaultExclusionReason: 'Human-only Agent governance endpoints' })
@Controller()
class AgentHumanController {
  constructor(
    @Inject(AgentAuthorizationService)
    private readonly authorization: AgentAuthorizationService,
    @Inject(AgentOperationService) private readonly operations: AgentOperationService,
  ) {}

  @Post('auth/step-up')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @AgentExcluded('A human super administrator must enter the password in the TokEMS browser')
  stepUp(@Body() body: unknown, @Req() request: AgentRequest) {
    return this.authorization.stepUp(body, requireHuman(request));
  }

  @Get('admin/agent-authorizations/:authorizationId')
  @AgentExcluded('Human browser authorization detail')
  authorizationDetail(@Param('authorizationId') id: string, @Req() request: AgentRequest) {
    return this.authorization.getAuthorization(id, requireHuman(request));
  }

  @Get('admin/agent-authorizations')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @AgentExcluded('Human browser authorization code resolution')
  resolveAuthorization(@Query('userCode') userCode: string, @Req() request: AgentRequest) {
    return this.authorization.resolveAuthorization(userCode, requireHuman(request));
  }

  @Post('admin/agent-authorizations/:authorizationId/approve')
  @AgentExcluded('Human browser authorization decision')
  approveAuthorization(
    @Param('authorizationId') id: string,
    @Body() body: unknown,
    @Req() request: AgentRequest,
  ) {
    return this.authorization.approveAuthorization(id, body, requireHuman(request));
  }

  @Post('admin/agent-authorizations/:authorizationId/deny')
  @AgentExcluded('Human browser authorization decision')
  denyAuthorization(@Param('authorizationId') id: string, @Req() request: AgentRequest) {
    return this.authorization.denyAuthorization(id, requireHuman(request));
  }

  @Get('admin/agent-connections')
  @AgentExcluded('Human browser connection governance')
  connections(@Req() request: AgentRequest) {
    return this.authorization.listConnections(requireHuman(request));
  }

  @Get('admin/agent-security-metrics')
  @AgentExcluded('Human browser Agent security metrics')
  securityMetrics(@Req() request: AgentRequest) {
    return this.authorization.securityMetrics(requireHuman(request));
  }

  @Patch('admin/agent-connections/:connectionId/policy')
  @AgentExcluded('Human browser connection governance')
  updatePolicy(
    @Param('connectionId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() request: AgentRequest,
  ) {
    return this.authorization.updateConnectionPolicy(id, body, requireHuman(request));
  }

  @Post('admin/agent-connections/:connectionId/revoke')
  @AgentExcluded('Human browser connection governance')
  revokeConnection(@Param('connectionId') id: string, @Req() request: AgentRequest) {
    return this.authorization.revokeConnection(id, requireHuman(request));
  }

  @Post('admin/agent-connections/revoke-all')
  @AgentExcluded('Human browser emergency revocation')
  revokeAll(@Body() body: Record<string, unknown>, @Req() request: AgentRequest) {
    return this.authorization.revokeAll(body, requireHuman(request));
  }

  @Post('admin/agent-operations/:operationId/approve')
  @AgentExcluded('Human browser operation approval')
  approveOperation(
    @Param('operationId') id: string,
    @Body() body: unknown,
    @Req() request: AgentRequest,
  ) {
    return this.operations.approve(id, body, requireHuman(request));
  }

  @Get('admin/agent-operations/:operationId')
  @AgentExcluded('Human browser operation approval detail')
  operationDetail(@Param('operationId') id: string, @Req() request: AgentRequest) {
    return this.operations.getForHuman(id, requireHuman(request));
  }

  @Post('admin/agent-operations/:operationId/deny')
  @AgentExcluded('Human browser operation approval')
  denyOperation(@Param('operationId') id: string, @Req() request: AgentRequest) {
    return this.operations.deny(id, requireHuman(request));
  }
}

@Module({
  controllers: [
    AgentWellKnownController,
    AgentOAuthController,
    AgentController,
    AgentHumanController,
  ],
})
export class AgentModule {}
