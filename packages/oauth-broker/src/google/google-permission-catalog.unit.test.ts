import { describe, expect, it } from 'vitest';

import {
	compileGooglePermissionSelection,
	getGooglePermissionGroups,
	googleReadOnlyRecommendation,
} from './google-permission-catalog.js';

describe('pinned Google permission groups', () => {
	it('requests Gmail read-only by recommendation, without a send-capable scope', () => {
		// Arrange
		const groupIds = googleReadOnlyRecommendation.selections.communications;
		// Act
		const result = compileGooglePermissionSelection({
			familyId: 'communications',
			groupIds,
			ceiling: groupIds,
		});
		// Assert
		expect(result.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
		expect(result.effects).toEqual({ gmail: ['read'] });
	});

	it('discloses broad Gmail write instead of inventing a draft-only token', () => {
		// Arrange / Act
		const result = compileGooglePermissionSelection({
			familyId: 'communications',
			groupIds: ['gmail.write'],
			ceiling: ['gmail.write'],
		});
		// Assert
		expect(result.scopes).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
		expect(result.effects).toEqual({ gmail: ['write'] });
		expect(result.warnings.join(' ')).toMatch(/read.*send/iu);
		expect(() =>
			compileGooglePermissionSelection({
				familyId: 'communications',
				groupIds: ['gmail.draft'],
				ceiling: ['gmail.write'],
			}),
		).toThrow();
	});

	it('uses all-files read for the document recommendation and deduplicates equivalent scopes', () => {
		// Arrange
		const groupIds = googleReadOnlyRecommendation.selections.documents;
		// Act
		const result = compileGooglePermissionSelection({
			familyId: 'documents',
			groupIds,
			ceiling: groupIds,
		});
		// Assert
		expect(result.scopes).toEqual(['https://www.googleapis.com/auth/drive.readonly']);
		expect(Object.keys(result.effects).toSorted()).toEqual(['docs', 'drive', 'sheets', 'slides']);
	});

	it('describes app-used file access honestly, including provider write authority', () => {
		// Arrange / Act
		const result = compileGooglePermissionSelection({
			familyId: 'documents',
			groupIds: ['drive.app-files.read'],
			ceiling: ['drive.app-files.read'],
		});
		// Assert
		expect(result.scopes).toEqual(['https://www.googleapis.com/auth/drive.file']);
		expect(result.warnings.join(' ')).toMatch(/creat/iu);
		expect(result.warnings.join(' ')).toMatch(/write/iu);
	});

	it('keeps Forms body and response scopes independent', () => {
		// Arrange / Act
		const body = compileGooglePermissionSelection({
			familyId: 'documents',
			groupIds: ['forms.body.read'],
			ceiling: ['forms.body.read'],
		});
		const responses = compileGooglePermissionSelection({
			familyId: 'documents',
			groupIds: ['forms.responses.read'],
			ceiling: ['forms.responses.read'],
		});
		// Assert
		expect(body.scopes).toEqual(['https://www.googleapis.com/auth/forms.body.readonly']);
		expect(responses.scopes).toEqual(['https://www.googleapis.com/auth/forms.responses.readonly']);
	});

	it('enforces exact family and ceiling without clamping', () => {
		// Arrange / Act / Assert
		expect(() =>
			compileGooglePermissionSelection({
				familyId: 'communications',
				groupIds: ['gmail.write'],
				ceiling: ['gmail.read'],
			}),
		).toThrow();
		expect(() =>
			compileGooglePermissionSelection({
				familyId: 'youtube',
				groupIds: ['gmail.read'],
				ceiling: ['gmail.read'],
			}),
		).toThrow();
		expect(() =>
			compileGooglePermissionSelection({
				familyId: 'communications',
				groupIds: ['gmail.read'],
				ceiling: [],
			}),
		).toThrow();
		expect(() =>
			compileGooglePermissionSelection({
				familyId: 'communications',
				groupIds: ['constructor'],
				ceiling: ['constructor'],
			}),
		).toThrow();
	});

	it('reports the scope union when all-file reading is combined with app-file writing', () => {
		// Arrange
		const groupIds = ['drive.app-files.write', 'docs.all-files.read'];
		// Act / Assert
		const result = compileGooglePermissionSelection({
			familyId: 'documents',
			groupIds,
			ceiling: groupIds,
		});
		expect(result.scopes).toEqual([
			'https://www.googleapis.com/auth/drive.file',
			'https://www.googleapis.com/auth/drive.readonly',
		]);
		expect(result.warnings.join(' ')).toMatch(/all accessible files/iu);
	});

	it('covers each supported service and gives every group truthful labels and warnings', () => {
		// Arrange / Act
		const groups = getGooglePermissionGroups();
		// Assert
		expect([...new Set(groups.map((group) => group.serviceId))].toSorted()).toEqual([
			'calendar',
			'contacts',
			'docs',
			'drive',
			'forms',
			'gmail',
			'sheets',
			'slides',
			'youtube',
		]);
		expect(groups.every((group) => group.label.length > 0 && group.scopes.length > 0)).toBe(true);
		expect(googleReadOnlyRecommendation.label).not.toBe('');
		expect(googleReadOnlyRecommendation.summary).not.toBe('');
		expect(googleReadOnlyRecommendation.rationale).not.toBe('');
	});
});
