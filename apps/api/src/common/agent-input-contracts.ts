import { z } from 'zod';
import * as contracts from '@conference/contracts';
import * as inputs from './management-inputs.js';

const empty = z.object({}).strict();
export const AGENT_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  'templates.create': contracts.CreateConferenceTemplateSchema,
  'templates.update': contracts.UpdateConferenceTemplateSchema,
  'templates.duplicate': inputs.DuplicateSchema,
  'templates.archive': inputs.ArchiveSchema,
  'templates.restore': inputs.ArchiveSchema,
  'templates.draft.update': contracts.SaveConferenceTemplateDraftSchema,
  'templates.publish': contracts.PublishConferenceTemplateSchema,
  'templates.event-binding.update': contracts.UpdateEventTemplateBindingSchema,
  'templates.html-bindings.update': inputs.SaveHtmlBindingsSchema,
  'templates.html-preview.create': empty,
  'templates.preview.create': inputs.TemplateCandidatePreviewSchema,
  'templates.assets.upload.prepare': inputs.PrepareTemplateAssetUploadSchema,
  'templates.assets.create': inputs.AssetSchema,
  'templates.assets.delete': empty,
  'templates.html-imports.prepare': inputs.PrepareHtmlImportSchema,
  'templates.html-imports.scan': empty,
  'templates.html-imports.retry': empty,
  'templates.html-imports.cancel': empty,
  'templates.html-imports.commit': inputs.CommitHtmlImportSchema,
  'events.create': contracts.CreateEventSchema,
  'events.update': contracts.UpdateEventSchema,
  'events.public-url.update': contracts.UpdateEventSlugSchema,
  'events.releases.publish': contracts.PublishEventSchema,
  'events.releases.rollback': empty,
  'events.experience.update': contracts.SaveEventExperienceOverrideSchema,
  'events.experience.validate': empty,
  'events.experience.preview': empty,
  'organization.homepage.update': contracts.UpdateOrganizationHomepageConfigurationSchema,
  'organization.homepage-event.update': contracts.SetOrganizationHomepageEventSchema,
  'content.speakers.create': contracts.CreateSpeakerSchema,
  'content.speakers.update': contracts.UpdateSpeakerSchema,
  'content.speakers.delete': empty,
  'content.speakers.order': contracts.ReorderSpeakersSchema,
  'content.sessions.create': inputs.SessionInputSchema,
  'content.sessions.update': inputs.SessionPatchSchema,
  'content.sessions.delete': empty,
  'content.registration-forms.publish': contracts.RegistrationFormPublishSchema,
  'content.ticket-types.create': inputs.TicketTypeInputSchema,
  'content.ticket-types.update': inputs.TicketTypeInputSchema.partial(),
  'content.ticket-types.delete': empty,
  'content.ticket-types.restore': empty,
  'cooperation.update': contracts.UpdateCooperationRequestSchema,
  'members.showcases.moderate': contracts.ModerateAttendeeShowcaseSchema,
  'content.services.update': contracts.UpdateEventAttendeeServiceConfigurationSchema,
  'registrations.notes.create': contracts.CreateRegistrationNoteSchema,
};

export function agentInputJsonSchema(actionId: string) {
  const schema = AGENT_INPUT_SCHEMAS[actionId];
  return schema ? z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) : undefined;
}
