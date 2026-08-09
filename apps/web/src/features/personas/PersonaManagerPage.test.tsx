// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { PersonaManagerPage } from './PersonaManagerPage.js';

const now = '2026-08-08T00:00:00.000Z';
const travelerId = '018f0000-0000-7000-8000-000000000911';
const scholarId = '018f0000-0000-7000-8000-000000000912';
let personas = [
  { id: travelerId, revision: 0, createdAt: now, updatedAt: now, name: 'Traveler', description: 'Curious visitor', isDefault: true },
  { id: scholarId, revision: 0, createdAt: now, updatedAt: now, name: 'Scholar', description: 'Careful reader', isDefault: false },
];
let conflictOnce = false;
let avatarCalls = 0;
let lastPatch: Record<string, unknown> | undefined;

const server = setupServer(
  http.get('/api/personas', () => HttpResponse.json(personas)),
  http.get('/api/personas/:id', ({ params }) => HttpResponse.json(personas.find((persona) => persona.id === params.id))),
  http.post('/api/personas', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    if (body.isDefault === true) personas = personas.map((persona) => ({ ...persona, isDefault: false }));
    const created = { ...body, revision: 0, createdAt: now, updatedAt: now, isDefault: body.isDefault === true } as typeof personas[number];
    personas.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),
  http.patch('/api/personas/:id', async ({ params, request }) => {
    const body = await request.json() as { revision: number; patch: Partial<typeof personas[number]> };
    lastPatch = body.patch;
    if (conflictOnce) {
      conflictOnce = false;
      personas = personas.map((persona) => persona.id === params.id
        ? { ...persona, revision: 3, description: 'Server changed Persona' }
        : persona);
      return HttpResponse.json({ error: 'conflict' }, { status: 409 });
    }
    if (body.patch.isDefault) personas = personas.map((persona) => ({ ...persona, isDefault: persona.id === params.id }));
    let updated: typeof personas[number] | undefined;
    personas = personas.map((persona) => {
      if (persona.id !== params.id) return persona;
      updated = { ...persona, ...body.patch, revision: body.revision + 1 };
      return updated;
    });
    return HttpResponse.json(updated);
  }),
  http.delete('/api/personas/:id', ({ params }) => {
    const deleted = personas.find((persona) => persona.id === params.id);
    personas = personas.filter((persona) => persona.id !== params.id);
    if (deleted?.isDefault && personas[0] !== undefined) personas[0] = { ...personas[0], isDefault: true };
    return new HttpResponse(null, { status: 204 });
  }),
  http.put('/api/personas/:id/avatar', async () => {
    avatarCalls += 1;
    return HttpResponse.json({ ...personas[0], avatarUrl: `/api/personas/${travelerId}/avatar?v=1` });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  personas = [
    { id: travelerId, revision: 0, createdAt: now, updatedAt: now, name: 'Traveler', description: 'Curious visitor', isDefault: true },
    { id: scholarId, revision: 0, createdAt: now, updatedAt: now, name: 'Scholar', description: 'Careful reader', isDefault: false },
  ];
  conflictOnce = false;
  avatarCalls = 0;
  lastPatch = undefined;
});
afterAll(() => server.close());

describe('PersonaManagerPage', () => {
  it('creates, edits, switches the single default, uploads an avatar, and promotes after delete', async () => {
    const user = userEvent.setup();
    renderWithApp(<PersonaManagerPage />);

    await user.click(await screen.findByRole('button', { name: 'Edit persona Scholar' }));
    expect((screen.getByLabelText('Default Persona') as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByLabelText('Default Persona'));
    await user.click(screen.getByRole('button', { name: 'Save Persona' }));
    await waitFor(() => expect(personas.filter((persona) => persona.isDefault).map((persona) => persona.id)).toEqual([scholarId]));

    await user.click(screen.getByRole('button', { name: 'New Persona' }));
    await user.type(screen.getByLabelText('Name'), 'Navigator');
    await user.type(screen.getByLabelText('Description'), 'Charts the unknown');
    await user.click(screen.getByLabelText('Default Persona'));
    await user.click(screen.getByRole('button', { name: 'Create Persona' }));
    expect(await screen.findByRole('button', { name: 'Edit persona Navigator' })).not.toBeNull();
    expect(personas.filter((persona) => persona.isDefault).map((persona) => persona.name)).toEqual(['Navigator']);

    await user.click(screen.getByRole('button', { name: 'Edit persona Traveler' }));
    await user.upload(screen.getByLabelText('Avatar file'), new File(['png'], 'traveler.png', { type: 'image/png' }));
    await waitFor(() => expect(avatarCalls).toBe(1));
    expect((screen.getByRole('img', { name: 'Traveler avatar' }) as HTMLImageElement).src).toContain(`/api/personas/${travelerId}/avatar`);
    await user.click(screen.getByRole('button', { name: 'Delete Persona' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete Persona' }));
    await waitFor(() => expect(personas.some((persona) => persona.id === travelerId)).toBe(false));
    expect(personas.filter((persona) => persona.isDefault)).toHaveLength(1);
  });

  it('shows a revision conflict without overwriting the Persona draft', async () => {
    const user = userEvent.setup();
    conflictOnce = true;
    renderWithApp(<PersonaManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit persona Traveler' }));
    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Local Persona draft');
    await user.click(screen.getByRole('button', { name: 'Save Persona' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Server revision 3');
    expect((description as HTMLTextAreaElement).value).toBe('Local Persona draft');
  });

  it('sends only the changed allowlisted Persona field', async () => {
    const user = userEvent.setup();
    renderWithApp(<PersonaManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit persona Traveler' }));
    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'Changed alone');
    await user.click(screen.getByRole('button', { name: 'Save Persona' }));

    await waitFor(() => expect(lastPatch).toBeDefined());
    expect(lastPatch).toEqual({ description: 'Changed alone' });
  });
});
