import { TYPERT_REMOTE } from './inspector-wire.ts'
export const TYPERT = {
  package: TYPERT_REMOTE.package, face: 'host', schemas: [], invocations: TYPERT_REMOTE.descriptors,
  model: { services: [{ key: 'contextInspector', exportName: 'ContextInspector', summary: 'Read-only context inspection for one selected Session.', tags: [], members: [
    { kind: 'method', name: 'inspect', signature: 'inspect(query: InspectQuery, signal: AbortSignal): Promise<Inspection>' },
    { kind: 'method', name: 'content', signature: 'content(query: ContentQuery, signal: AbortSignal): Promise<ContentPage>' },
  ], types: [] }], events: [], objects: [] },
}
