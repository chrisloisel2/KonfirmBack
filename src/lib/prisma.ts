import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

type AnyRecord = Record<string, any>;
type OrderBy = Record<string, 'asc' | 'desc'>;

interface QueryContext {
	cache: Map<string, Promise<AnyRecord[]>>;
}

interface RelationMeta {
	type: 'one' | 'many';
	model: string;
	localField?: string;
	foreignField?: string;
}

interface ModelMeta {
	collection: string;
	timestamps?: {
		createdAt?: string;
		updatedAt?: string;
	};
	defaults?: () => AnyRecord;
	uniqueFields?: string[];
	relations?: Record<string, RelationMeta>;
}

declare global {
	// eslint-disable-next-line no-var
	var __mongoDbPromise: Promise<any> | undefined;
	// eslint-disable-next-line no-var
	var __mongoClientPromise: Promise<any> | undefined;
	// eslint-disable-next-line no-var
	var __mongoPrismaCompat: any;
}

const MODEL_META: Record<string, ModelMeta> = {
	user: {
		collection: 'users',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'email'],
		defaults: () => ({
			isActive: true,
			isBlocked: false,
			loginAttempts: 0,
		}),
		relations: {
			createdDossiers: { type: 'many', model: 'dossier', foreignField: 'createdById', localField: 'id' },
			assignedDossiers: { type: 'many', model: 'dossier', foreignField: 'assignedToId', localField: 'id' },
			validatedDossiers: { type: 'many', model: 'dossier', foreignField: 'validatedById', localField: 'id' },
			documents: { type: 'many', model: 'document', foreignField: 'uploadedById', localField: 'id' },
			auditLogs: { type: 'many', model: 'auditLog', foreignField: 'userId', localField: 'id' },
			exceptions: { type: 'many', model: 'exception', foreignField: 'assignedToId', localField: 'id' },
			sessions: { type: 'many', model: 'session', foreignField: 'userId', localField: 'id' },
			tracfinDeclarations: { type: 'many', model: 'tracfinDeclaration', foreignField: 'createdById', localField: 'id' },
			savedSearches: { type: 'many', model: 'savedSearch', foreignField: 'userId', localField: 'id' },
			searchHistory: { type: 'many', model: 'searchHistory', foreignField: 'userId', localField: 'id' },
			watchlists: { type: 'many', model: 'watchlist', foreignField: 'userId', localField: 'id' },
			intelligenceReports: { type: 'many', model: 'intelligenceReport', foreignField: 'userId', localField: 'id' },
			batchSearches: { type: 'many', model: 'batchSearch', foreignField: 'userId', localField: 'id' },
		},
	},
	session: {
		collection: 'sessions',
		timestamps: { createdAt: 'createdAt' },
		uniqueFields: ['id', 'sessionId'],
		defaults: () => ({ isValid: true }),
		relations: {
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
		},
	},
	client: {
		collection: 'clients',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'numeroIdentite'],
		defaults: () => ({
			pays: 'France',
			personnePublique: false,
		}),
		relations: {
			dossiers: { type: 'many', model: 'dossier', foreignField: 'clientId', localField: 'id' },
		},
	},
	dossier: {
		collection: 'dossiers',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'numero'],
		defaults: () => ({ status: 'BROUILLON' }),
		relations: {
			client: { type: 'one', model: 'client', localField: 'clientId', foreignField: 'id' },
			createdBy: { type: 'one', model: 'user', localField: 'createdById', foreignField: 'id' },
			assignedTo: { type: 'one', model: 'user', localField: 'assignedToId', foreignField: 'id' },
			validatedBy: { type: 'one', model: 'user', localField: 'validatedById', foreignField: 'id' },
			documents: { type: 'many', model: 'document', foreignField: 'dossierId', localField: 'id' },
			recherches: { type: 'many', model: 'recherche', foreignField: 'dossierId', localField: 'id' },
			exceptions: { type: 'many', model: 'exception', foreignField: 'dossierId', localField: 'id' },
			auditLogs: { type: 'many', model: 'auditLog', foreignField: 'dossierId', localField: 'id' },
			tracfinDeclarations: { type: 'many', model: 'tracfinDeclaration', foreignField: 'dossierId', localField: 'id' },
			scoring: { type: 'one', model: 'scoring', foreignField: 'dossierId', localField: 'id' },
		},
	},
	document: {
		collection: 'documents',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({ isVerified: false }),
		relations: {
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
			uploadedBy: { type: 'one', model: 'user', localField: 'uploadedById', foreignField: 'id' },
		},
	},
	recherche: {
		collection: 'recherches',
		timestamps: { createdAt: 'executedAt' },
		uniqueFields: ['id'],
		defaults: () => ({ status: 'EN_COURS' }),
		relations: {
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
		},
	},
	exception: {
		collection: 'exceptions',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			priority: 'NORMALE',
			status: 'EN_ATTENTE',
		}),
		relations: {
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
			assignedTo: { type: 'one', model: 'user', localField: 'assignedToId', foreignField: 'id' },
		},
	},
	scoring: {
		collection: 'scorings',
		timestamps: { createdAt: 'calculatedAt', updatedAt: 'calculatedAt' },
		uniqueFields: ['id', 'dossierId'],
		relations: {
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
		},
	},
	auditLog: {
		collection: 'audit_logs',
		timestamps: { createdAt: 'timestamp', updatedAt: 'timestamp' },
		uniqueFields: ['id'],
		relations: {
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
		},
	},
	configuration: {
		collection: 'configurations',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'key'],
		defaults: () => ({
			category: 'general',
			isActive: true,
		}),
	},
	referenceList: {
		collection: 'reference_lists',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({ isActive: true }),
	},
	tracfinDeclaration: {
		collection: 'tracfin_declarations',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'ermesReference'],
		defaults: () => ({
			devise: 'EUR',
			status: 'BROUILLON',
		}),
		relations: {
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
			createdBy: { type: 'one', model: 'user', localField: 'createdById', foreignField: 'id' },
		},
	},
	savedSearch: {
		collection: 'saved_searches',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			searchType: 'UNIVERSAL',
			isAlertEnabled: false,
			alertThreshold: 0.7,
		}),
		relations: {
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
		},
	},
	searchHistory: {
		collection: 'search_history',
		timestamps: { createdAt: 'createdAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			resultsCount: 0,
			entityTypes: [],
			sources: [],
			durationMs: 0,
		}),
		relations: {
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
		},
	},
	watchlist: {
		collection: 'watchlists',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			color: '#3B82F6',
			isActive: true,
			checkFrequency: 'DAILY',
			totalAlerts: 0,
			entities: [],
		}),
		relations: {
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
			alerts: { type: 'many', model: 'watchlistAlert', foreignField: 'watchlistId', localField: 'id' },
		},
	},
	watchlistAlert: {
		collection: 'watchlist_alerts',
		timestamps: { createdAt: 'createdAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			severity: 'MEDIUM',
			isRead: false,
			isActioned: false,
		}),
		relations: {
			watchlist: { type: 'one', model: 'watchlist', localField: 'watchlistId', foreignField: 'id' },
		},
	},
	intelligenceReport: {
		collection: 'intelligence_reports',
		timestamps: { createdAt: 'createdAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			subjectType: 'PERSON',
			sourcesQueried: [],
			sourcesHit: [],
			totalMatches: 0,
		}),
		relations: {
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
		},
	},
	batchSearch: {
		collection: 'batch_searches',
		timestamps: { createdAt: 'createdAt', updatedAt: 'completedAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			searchTypes: [],
			totalRecords: 0,
			processedCount: 0,
			hitCount: 0,
			status: 'PENDING',
			inputData: [],
		}),
		relations: {
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
			results: { type: 'many', model: 'batchSearchResult', foreignField: 'batchId', localField: 'id' },
		},
	},
	batchSearchResult: {
		collection: 'batch_search_results',
		timestamps: { createdAt: 'processedAt', updatedAt: 'processedAt' },
		uniqueFields: ['id'],
		defaults: () => ({
			hasHit: false,
			matches: [],
			sources: [],
		}),
		relations: {
			batch: { type: 'one', model: 'batchSearch', localField: 'batchId', foreignField: 'id' },
		},
	},
	company: {
		collection: 'companies',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({}),
		relations: {
			users: { type: 'many', model: 'user', foreignField: 'companyId', localField: 'id' },
			shops: { type: 'many', model: 'shop', foreignField: 'companyId', localField: 'id' },
			subscription: { type: 'one', model: 'subscription', foreignField: 'companyId', localField: 'id' },
		},
	},
	shop: {
		collection: 'shops',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({ isActive: true, userIds: [] }),
		relations: {
			company: { type: 'one', model: 'company', localField: 'companyId', foreignField: 'id' },
			// Utilise user.shopIds comme source de vérité (pas shop.userIds)
			users: { type: 'many', model: 'user', localField: 'id', foreignField: 'shopIds' },
		},
	},
	activationKey: {
		collection: 'activation_keys',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'code'],
		defaults: () => ({
			status: 'ACTIVE',
			isRedeemed: false,
			plan: 'PRO',
			billingCycle: 'MONTHLY',
			priceCents: 9900,
			currency: 'EUR',
			seats: 1,
		}),
		relations: {
			redeemedByUser: { type: 'one', model: 'user', localField: 'redeemedByUserId', foreignField: 'id' },
		},
	},
	subscription: {
		collection: 'subscriptions',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'companyId'],
		defaults: () => ({
			status: 'ACTIVE',
			plan: 'PRO',
			billingCycle: 'MONTHLY',
			currency: 'EUR',
			seats: 1,
			features: [],
		}),
		relations: {
			company: { type: 'one', model: 'company', localField: 'companyId', foreignField: 'id' },
			owner: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
			activationKey: { type: 'one', model: 'activationKey', localField: 'activationKeyId', foreignField: 'id' },
			payments: { type: 'many', model: 'payment', foreignField: 'subscriptionId', localField: 'id' },
		},
	},
	payment: {
		collection: 'payments',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'reference'],
		defaults: () => ({
			status: 'PAID',
			method: 'ACTIVATION_KEY',
			currency: 'EUR',
		}),
		relations: {
			subscription: { type: 'one', model: 'subscription', localField: 'subscriptionId', foreignField: 'id' },
			user: { type: 'one', model: 'user', localField: 'userId', foreignField: 'id' },
		},
	},
	configurationScoring: {
		collection: 'configuration_scoring',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id', 'nom'],
		defaults: () => ({ isActive: true }),
	},
	facteurRisque: {
		collection: 'facteurs_risque',
		timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
		uniqueFields: ['id'],
		defaults: () => ({ isActive: true }),
	},
	archivedPdf: {
		collection: 'archived_pdfs',
		timestamps: { createdAt: 'archivedAt', updatedAt: 'archivedAt' },
		uniqueFields: ['id'],
		defaults: () => ({ isImmutable: true, isPdfa: false }),
		relations: {
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
		},
	},
	archivedDocument: {
		collection: 'archived_documents',
		timestamps: { createdAt: 'archivedAt', updatedAt: 'archivedAt' },
		uniqueFields: ['id', 'documentId'],
		defaults: () => ({ isImmutable: true }),
		relations: {
			dossier: { type: 'one', model: 'dossier', localField: 'dossierId', foreignField: 'id' },
			document: { type: 'one', model: 'document', localField: 'documentId', foreignField: 'id' },
		},
	},
};

function createQueryContext(): QueryContext {
	return { cache: new Map<string, Promise<AnyRecord[]>>() };
}

function ensureMongoUrl(): string {
	const url = process.env.DATABASE_URL || process.env.MONGODB_URI || process.env.MONGO_URL;
	if (!url) {
		throw new Error('Aucune URL MongoDB trouvée. Configurez DATABASE_URL ou MONGODB_URI.');
	}
	if (!url.startsWith('mongodb://') && !url.startsWith('mongodb+srv://')) {
		throw new Error(`URL de base non supportée (${url}). Utilisez une URL MongoDB.`);
	}
	return url;
}

async function getMongoDb(): Promise<any> {
	if (global.__mongoDbPromise) return global.__mongoDbPromise;

	const mongo = require('mongodb');
	const MongoClient = mongo?.MongoClient;

	if (!MongoClient) {
		throw new Error("Le driver 'mongodb' est requis. Installez-le avant de démarrer le backend.");
	}

	const url = ensureMongoUrl();
	const client = new MongoClient(url, {
		ignoreUndefined: true,
		serverSelectionTimeoutMS: 30000,
		connectTimeoutMS: 30000,
		socketTimeoutMS: 45000,
	});
	const clientPromise = client.connect();

	global.__mongoClientPromise = clientPromise;
	global.__mongoDbPromise = clientPromise.then((connectedClient: any) => connectedClient.db());

	return global.__mongoDbPromise;
}

function isPlainObject(value: unknown): value is AnyRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function deepClone<T>(value: T): T {
	if (value === undefined) return value;
	return structuredClone(value);
}

function createId(): string {
	return `c${randomUUID().replace(/-/g, '')}`;
}

function asDate(value: any): Date | null {
	if (value instanceof Date) return value;
	if (typeof value === 'string' || typeof value === 'number') {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return null;
}

function getFieldValue(record: AnyRecord | null | undefined, path: string): any {
	if (!record) return undefined;
	return path.split('.').reduce<any>((current: any, key: string) => current?.[key], record);
}

function removeUndefined(value: any): any {
	if (Array.isArray(value)) {
		return value.map((item: any) => removeUndefined(item));
	}
	if (isPlainObject(value)) {
		const clean: AnyRecord = {};
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) {
				clean[key] = removeUndefined(entry);
			}
		}
		return clean;
	}
	return value;
}

function fromMongoDocument(document: AnyRecord | null): AnyRecord | null {
	if (!document) return null;
	const plain = deepClone(document);
	if (plain._id !== undefined && plain.id === undefined) {
		plain.id = String(plain._id);
	}
	delete plain._id;
	return plain;
}

function toMongoDocument(document: AnyRecord): AnyRecord {
	const mongoDocument = removeUndefined(deepClone(document));
	mongoDocument._id = document.id;
	delete mongoDocument.id;
	return mongoDocument;
}

function mergeWhere(baseWhere?: AnyRecord, extraWhere?: AnyRecord): AnyRecord | undefined {
	if (baseWhere && extraWhere) return { AND: [baseWhere, extraWhere] };
	return baseWhere || extraWhere;
}

function hasOperatorKeys(value: AnyRecord): boolean {
	const operatorKeys = [
		'equals',
		'contains',
		'startsWith',
		'endsWith',
		'in',
		'gte',
		'lte',
		'gt',
		'lt',
		'not',
		'has',
		'hasSome',
		'hasEvery',
		'some',
		'none',
		'every',
	];
	return Object.keys(value).some((key: string) => operatorKeys.includes(key));
}

function compareScalar(fieldValue: any, condition: any): boolean {
	if (!isPlainObject(condition) || !hasOperatorKeys(condition)) {
		if (condition instanceof Date) {
			const fieldDate = asDate(fieldValue);
			return !!fieldDate && fieldDate.getTime() === condition.getTime();
		}
		if (Array.isArray(condition)) {
			return Array.isArray(fieldValue) && condition.every((entry: any, index: number) => fieldValue[index] === entry);
		}
		return fieldValue === condition;
	}

	const modeInsensitive = condition.mode === 'insensitive';
	const normalizedField = typeof fieldValue === 'string' && modeInsensitive ? fieldValue.toLowerCase() : fieldValue;

	if (condition.equals !== undefined) {
		const expected = typeof condition.equals === 'string' && modeInsensitive ? condition.equals.toLowerCase() : condition.equals;
		if (normalizedField !== expected) return false;
	}

	if (condition.contains !== undefined) {
		if (typeof fieldValue !== 'string') return false;
		const haystack = modeInsensitive ? fieldValue.toLowerCase() : fieldValue;
		const needle = modeInsensitive ? String(condition.contains).toLowerCase() : String(condition.contains);
		if (!haystack.includes(needle)) return false;
	}

	if (condition.startsWith !== undefined) {
		if (typeof fieldValue !== 'string') return false;
		const haystack = modeInsensitive ? fieldValue.toLowerCase() : fieldValue;
		const needle = modeInsensitive ? String(condition.startsWith).toLowerCase() : String(condition.startsWith);
		if (!haystack.startsWith(needle)) return false;
	}

	if (condition.endsWith !== undefined) {
		if (typeof fieldValue !== 'string') return false;
		const haystack = modeInsensitive ? fieldValue.toLowerCase() : fieldValue;
		const needle = modeInsensitive ? String(condition.endsWith).toLowerCase() : String(condition.endsWith);
		if (!haystack.endsWith(needle)) return false;
	}

	if (condition.in !== undefined) {
		if (!Array.isArray(condition.in) || !condition.in.includes(fieldValue)) return false;
	}

	if (condition.gte !== undefined) {
		if ((fieldValue instanceof Date || condition.gte instanceof Date) && asDate(fieldValue) && asDate(condition.gte)) {
			if ((asDate(fieldValue) as Date).getTime() < (asDate(condition.gte) as Date).getTime()) return false;
		} else if (fieldValue < condition.gte) {
			return false;
		}
	}

	if (condition.lte !== undefined) {
		if ((fieldValue instanceof Date || condition.lte instanceof Date) && asDate(fieldValue) && asDate(condition.lte)) {
			if ((asDate(fieldValue) as Date).getTime() > (asDate(condition.lte) as Date).getTime()) return false;
		} else if (fieldValue > condition.lte) {
			return false;
		}
	}

	if (condition.gt !== undefined) {
		if ((fieldValue instanceof Date || condition.gt instanceof Date) && asDate(fieldValue) && asDate(condition.gt)) {
			if ((asDate(fieldValue) as Date).getTime() <= (asDate(condition.gt) as Date).getTime()) return false;
		} else if (fieldValue <= condition.gt) {
			return false;
		}
	}

	if (condition.lt !== undefined) {
		if ((fieldValue instanceof Date || condition.lt instanceof Date) && asDate(fieldValue) && asDate(condition.lt)) {
			if ((asDate(fieldValue) as Date).getTime() >= (asDate(condition.lt) as Date).getTime()) return false;
		} else if (fieldValue >= condition.lt) {
			return false;
		}
	}

	if (condition.has !== undefined) {
		if (!Array.isArray(fieldValue) || !fieldValue.includes(condition.has)) return false;
	}

	if (condition.hasSome !== undefined) {
		if (!Array.isArray(fieldValue) || !Array.isArray(condition.hasSome) || !condition.hasSome.some((entry: any) => fieldValue.includes(entry))) {
			return false;
		}
	}

	if (condition.hasEvery !== undefined) {
		if (!Array.isArray(fieldValue) || !Array.isArray(condition.hasEvery) || !condition.hasEvery.every((entry: any) => fieldValue.includes(entry))) {
			return false;
		}
	}

	if (condition.not !== undefined && compareScalar(fieldValue, condition.not)) {
		return false;
	}

	return true;
}

async function loadDocuments(modelName: string, context: QueryContext): Promise<AnyRecord[]> {
	if (!context.cache.has(modelName)) {
		const meta = MODEL_META[modelName];
		if (!meta) {
			throw new Error(`Modèle Mongo inconnu: ${modelName}`);
		}
		const promise = getMongoDb()
			.then((db: any) => db.collection(meta.collection).find({}).toArray())
			.then((documents: AnyRecord[]) => documents.map((document: AnyRecord) => fromMongoDocument(document) as AnyRecord));
		context.cache.set(modelName, promise);
	}
	return context.cache.get(modelName) as Promise<AnyRecord[]>;
}

async function findRelatedOne(parentDoc: AnyRecord, relation: RelationMeta, context: QueryContext): Promise<AnyRecord | null> {
	const docs = await loadDocuments(relation.model, context);
	if (relation.localField && relation.foreignField === 'id') {
		return docs.find((doc: AnyRecord) => doc.id === parentDoc[relation.localField as string]) || null;
	}
	if (relation.localField === 'id' && relation.foreignField) {
		return docs.find((doc: AnyRecord) => doc[relation.foreignField as string] === parentDoc.id) || null;
	}
	return null;
}

async function findRelatedMany(parentDoc: AnyRecord, relation: RelationMeta, context: QueryContext): Promise<AnyRecord[]> {
	const docs = await loadDocuments(relation.model, context);

	if (relation.localField === 'id' && relation.foreignField) {
		// one→many : trouver les docs dont foreignField contient/égale parentDoc.id
		return docs.filter((doc: AnyRecord) => {
			const fv = doc[relation.foreignField as string];
			return Array.isArray(fv) ? fv.includes(parentDoc.id) : fv === parentDoc.id;
		});
	}

	if (relation.localField && relation.foreignField === 'id') {
		// join par tableau : trouver les docs dont l'id est dans parentDoc.localField
		const localValue = parentDoc[relation.localField as string];
		if (Array.isArray(localValue)) {
			return docs.filter((doc: AnyRecord) => (localValue as string[]).includes(doc.id));
		}
		return docs.filter((doc: AnyRecord) => doc.id === localValue);
	}

	return [];
}

async function matchesWhere(modelName: string, document: AnyRecord, where: AnyRecord | undefined, context: QueryContext): Promise<boolean> {
	if (!where || Object.keys(where).length === 0) return true;

	if (Array.isArray(where.AND)) {
		for (const clause of where.AND) {
			if (!(await matchesWhere(modelName, document, clause, context))) return false;
		}
	}

	if (Array.isArray(where.OR) && where.OR.length > 0) {
		const atLeastOne = await Promise.all(where.OR.map((clause: AnyRecord) => matchesWhere(modelName, document, clause, context)));
		if (!atLeastOne.some(Boolean)) return false;
	}

	if (Array.isArray(where.NOT) && where.NOT.length > 0) {
		const noClauseMatch = await Promise.all(where.NOT.map((clause: AnyRecord) => matchesWhere(modelName, document, clause, context)));
		if (noClauseMatch.some(Boolean)) return false;
	}

	const meta = MODEL_META[modelName];
	const ignoredKeys = new Set(['AND', 'OR', 'NOT']);

	for (const [key, condition] of Object.entries(where)) {
		if (ignoredKeys.has(key)) continue;

		if (key === 'id') {
			if (!compareScalar(document.id, condition)) return false;
			continue;
		}

		const relation = meta.relations?.[key];
		if (relation) {
			if (relation.type === 'one') {
				const related = await findRelatedOne(document, relation, context);
				if (!related || !(await matchesWhere(relation.model, related, condition as AnyRecord, context))) {
					return false;
				}
				continue;
			}

			const relatedDocs = await findRelatedMany(document, relation, context);
			const relationCondition = condition as AnyRecord;

			if (relationCondition.some !== undefined) {
				const someMatch = await Promise.all(relatedDocs.map((relatedDoc: AnyRecord) => matchesWhere(relation.model, relatedDoc, relationCondition.some, context)));
				if (!someMatch.some(Boolean)) return false;
				continue;
			}

			if (relationCondition.none !== undefined) {
				const noneMatch = await Promise.all(relatedDocs.map((relatedDoc: AnyRecord) => matchesWhere(relation.model, relatedDoc, relationCondition.none, context)));
				if (noneMatch.some(Boolean)) return false;
				continue;
			}

			if (relationCondition.every !== undefined) {
				const everyMatch = await Promise.all(relatedDocs.map((relatedDoc: AnyRecord) => matchesWhere(relation.model, relatedDoc, relationCondition.every, context)));
				if (!everyMatch.every(Boolean)) return false;
				continue;
			}

			const nestedMatch = await Promise.all(relatedDocs.map((relatedDoc: AnyRecord) => matchesWhere(relation.model, relatedDoc, relationCondition, context)));
			if (!nestedMatch.some(Boolean)) return false;
			continue;
		}

		const fieldValue = getFieldValue(document, key);
		if (isPlainObject(condition) && !hasOperatorKeys(condition)) {
			if (!isPlainObject(fieldValue)) return false;
			if (!(await matchesWhere(modelName, fieldValue, condition, context))) return false;
			continue;
		}

		if (!compareScalar(fieldValue, condition)) return false;
	}

	return true;
}

function sortDocuments(documents: AnyRecord[], orderBy?: OrderBy | OrderBy[]): AnyRecord[] {
	if (!orderBy) return documents;

	const orderClauses = Array.isArray(orderBy) ? orderBy : [orderBy];

	return documents.sort((left: AnyRecord, right: AnyRecord) => {
		for (const clause of orderClauses) {
			const [field, direction] = Object.entries(clause)[0] || [];
			if (!field || !direction) continue;

			const leftValue = getFieldValue(left, field);
			const rightValue = getFieldValue(right, field);

			if (leftValue === rightValue) continue;
			if (leftValue === undefined || leftValue === null) return direction === 'asc' ? 1 : -1;
			if (rightValue === undefined || rightValue === null) return direction === 'asc' ? -1 : 1;

			if (leftValue > rightValue) return direction === 'asc' ? 1 : -1;
			if (leftValue < rightValue) return direction === 'asc' ? -1 : 1;
		}
		return 0;
	});
}

async function applySelect(modelName: string, document: AnyRecord, select: AnyRecord, context: QueryContext): Promise<AnyRecord> {
	const selected: AnyRecord = {};
	const meta = MODEL_META[modelName];

	for (const [key, value] of Object.entries(select)) {
		if (!value) continue;

		if (key === '_count' && isPlainObject(value)) {
			selected._count = await buildCountSelection(modelName, document, value.select || {}, context);
			continue;
		}

		const relation = meta.relations?.[key];
		if (relation) {
			selected[key] = await loadRelationValue(document, relation, value === true ? {} : (value as AnyRecord), context);
			continue;
		}

		selected[key] = document[key];
	}

	return selected;
}

async function buildCountSelection(modelName: string, document: AnyRecord, select: AnyRecord, context: QueryContext): Promise<AnyRecord> {
	const counts: AnyRecord = {};
	const meta = MODEL_META[modelName];

	for (const [relationName, enabled] of Object.entries(select)) {
		if (!enabled) continue;
		const relation = meta.relations?.[relationName];
		if (!relation) continue;

		if (relation.type === 'many') {
			const related = await findRelatedMany(document, relation, context);
			counts[relationName] = related.length;
		} else {
			const related = await findRelatedOne(document, relation, context);
			counts[relationName] = related ? 1 : 0;
		}
	}

	return counts;
}

async function loadRelationValue(parentDoc: AnyRecord, relation: RelationMeta, relationArgs: AnyRecord, context: QueryContext): Promise<any> {
	if (relation.type === 'one') {
		const related = await findRelatedOne(parentDoc, relation, context);
		if (!related) return null;

		if (relationArgs.where && !(await matchesWhere(relation.model, related, relationArgs.where, context))) {
			return null;
		}

		return shapeDocument(relation.model, related, relationArgs, context);
	}

	const baseWhere =
		relation.localField === 'id'
			? { [relation.foreignField as string]: parentDoc.id }
			: { id: parentDoc[relation.localField as string] };

	const related = await findManyInternal(
		relation.model,
		{
			where: mergeWhere(baseWhere, relationArgs.where),
			orderBy: relationArgs.orderBy,
			skip: relationArgs.skip,
			take: relationArgs.take,
			select: relationArgs.select,
			include: relationArgs.include,
		},
		context
	);

	return related;
}

async function shapeDocument(modelName: string, document: AnyRecord, args: AnyRecord | undefined, context: QueryContext): Promise<AnyRecord> {
	const cloned = deepClone(document);
	const meta = MODEL_META[modelName];

	if (args?.include) {
		for (const [key, value] of Object.entries(args.include)) {
			if (!value) continue;

			if (key === '_count') {
				cloned._count = await buildCountSelection(modelName, cloned, (value as AnyRecord).select || {}, context);
				continue;
			}

			const relation = meta.relations?.[key];
			if (!relation) continue;
			cloned[key] = await loadRelationValue(cloned, relation, value === true ? {} : (value as AnyRecord), context);
		}
	}

	if (args?.select) {
		return applySelect(modelName, cloned, args.select, context);
	}

	return cloned;
}

async function findManyInternal(modelName: string, args: AnyRecord | undefined, context: QueryContext): Promise<AnyRecord[]> {
	const allDocuments = await loadDocuments(modelName, context);
	const filtered = (
		await Promise.all(
			allDocuments.map(async (document: AnyRecord) => ({
				document,
				matches: await matchesWhere(modelName, document, args?.where, context),
			}))
		)
	)
		.filter((entry: { document: AnyRecord; matches: boolean }) => entry.matches)
		.map((entry: { document: AnyRecord }) => deepClone(entry.document));

	const sorted = sortDocuments(filtered, args?.orderBy);
	const start = args?.skip || 0;
	const end = args?.take !== undefined ? start + args.take : undefined;
	const paginated = sorted.slice(start, end);

	return Promise.all(paginated.map((document: AnyRecord) => shapeDocument(modelName, document, args, context)));
}

async function ensureUniqueFields(modelName: string, candidate: AnyRecord, currentId?: string): Promise<void> {
	const meta = MODEL_META[modelName];
	const uniqueFields = meta.uniqueFields || [];
	if (uniqueFields.length === 0) return;

	const context = createQueryContext();
	const documents = await loadDocuments(modelName, context);

	for (const field of uniqueFields) {
		const value = candidate[field];
		if (value === undefined || value === null) continue;

		const conflict = documents.find((document: AnyRecord) => document[field] === value && document.id !== currentId);
		if (conflict) {
			throw new Error(`Violation unicité sur ${modelName}.${field}`);
		}
	}
}

function applyModelDefaults(modelName: string, data: AnyRecord, isCreate: boolean): AnyRecord {
	const meta = MODEL_META[modelName];
	const now = new Date();
	const document = {
		...(meta.defaults ? meta.defaults() : {}),
		...deepClone(data),
	};

	if (!document.id) {
		document.id = createId();
	}

	if (meta.timestamps?.createdAt && isCreate && document[meta.timestamps.createdAt] === undefined) {
		document[meta.timestamps.createdAt] = now;
	}

	if (meta.timestamps?.updatedAt) {
		document[meta.timestamps.updatedAt] = document[meta.timestamps.updatedAt] ?? now;
	}

	return document;
}

function applyUpdateData(modelName: string, existing: AnyRecord, data: AnyRecord): AnyRecord {
	const meta = MODEL_META[modelName];
	const updated = deepClone(existing);

	for (const [key, value] of Object.entries(data)) {
		if (isPlainObject(value) && Object.keys(value).length === 1 && value.increment !== undefined) {
			updated[key] = (updated[key] || 0) + Number(value.increment);
			continue;
		}
		if (isPlainObject(value) && Object.keys(value).length === 1 && value.decrement !== undefined) {
			updated[key] = (updated[key] || 0) - Number(value.decrement);
			continue;
		}
		if (isPlainObject(value) && Object.keys(value).length === 1 && value.set !== undefined) {
			updated[key] = deepClone(value.set);
			continue;
		}

		updated[key] = deepClone(value);
	}

	if (meta.timestamps?.updatedAt && data[meta.timestamps.updatedAt] === undefined) {
		updated[meta.timestamps.updatedAt] = new Date();
	}

	return updated;
}

function createModelDelegate(modelName: string): AnyRecord {
	const meta = MODEL_META[modelName];

	return {
		async findUnique(args: AnyRecord): Promise<AnyRecord | null> {
			const results = await findManyInternal(modelName, { ...args, take: 1 }, createQueryContext());
			return results[0] || null;
		},

		async findFirst(args: AnyRecord = {}): Promise<AnyRecord | null> {
			const results = await findManyInternal(modelName, { ...args, take: 1 }, createQueryContext());
			return results[0] || null;
		},

		async findMany(args: AnyRecord = {}): Promise<AnyRecord[]> {
			return findManyInternal(modelName, args, createQueryContext());
		},

		async count(args: AnyRecord = {}): Promise<number> {
			const results = await findManyInternal(modelName, { where: args.where }, createQueryContext());
			return results.length;
		},

		async create(args: AnyRecord): Promise<AnyRecord> {
			const db = await getMongoDb();
			const document = applyModelDefaults(modelName, args.data || {}, true);
			await ensureUniqueFields(modelName, document);
			await db.collection(meta.collection).insertOne(toMongoDocument(document));
			return shapeDocument(modelName, document, args, createQueryContext());
		},

		async createMany(args: AnyRecord): Promise<{ count: number }> {
			const db = await getMongoDb();
			const data = Array.isArray(args.data) ? args.data : [];
			let count = 0;

			for (const item of data) {
				const document = applyModelDefaults(modelName, item, true);
				try {
					await ensureUniqueFields(modelName, document);
					await db.collection(meta.collection).insertOne(toMongoDocument(document));
					count += 1;
				} catch (error) {
					if (!args.skipDuplicates) throw error;
				}
			}

			return { count };
		},

		async update(args: AnyRecord): Promise<AnyRecord> {
			const db = await getMongoDb();
			const current = await this.findUnique({ where: args.where });
			if (!current) throw new Error(`${modelName} introuvable`);

			const updated = applyUpdateData(modelName, current, args.data || {});
			await ensureUniqueFields(modelName, updated, current.id);
			await db.collection(meta.collection).replaceOne({ _id: current.id }, toMongoDocument(updated), { upsert: false });
			return shapeDocument(modelName, updated, args, createQueryContext());
		},

		async updateMany(args: AnyRecord): Promise<{ count: number }> {
			const db = await getMongoDb();
			const current = await findManyInternal(modelName, { where: args.where }, createQueryContext());
			let count = 0;

			for (const document of current) {
				const updated = applyUpdateData(modelName, document, args.data || {});
				await ensureUniqueFields(modelName, updated, document.id);
				await db.collection(meta.collection).replaceOne({ _id: document.id }, toMongoDocument(updated), { upsert: false });
				count += 1;
			}

			return { count };
		},

		async delete(args: AnyRecord): Promise<AnyRecord> {
			const db = await getMongoDb();
			const current = await this.findUnique({ where: args.where });
			if (!current) throw new Error(`${modelName} introuvable`);

			await db.collection(meta.collection).deleteOne({ _id: current.id });
			return current;
		},

		async deleteMany(args: AnyRecord = {}): Promise<{ count: number }> {
			const db = await getMongoDb();
			const current = await findManyInternal(modelName, { where: args.where }, createQueryContext());
			let count = 0;

			for (const document of current) {
				await db.collection(meta.collection).deleteOne({ _id: document.id });
				count += 1;
			}

			return { count };
		},

		async upsert(args: AnyRecord): Promise<AnyRecord> {
			const existing = await this.findUnique({ where: args.where });

			if (existing) {
				return this.update({
					where: { id: existing.id },
					data: args.update || {},
					select: args.select,
					include: args.include,
				});
			}

			return this.create({
				data: args.create || {},
				select: args.select,
				include: args.include,
			});
		},

		async groupBy(args: AnyRecord): Promise<AnyRecord[]> {
			const documents = await findManyInternal(modelName, { where: args.where }, createQueryContext());
			const byFields = Array.isArray(args.by) ? args.by : [];
			const groups = new Map<string, AnyRecord[]>();

			for (const document of documents) {
				const keyPayload = byFields.map((field: string) => getFieldValue(document, field));
				const key = JSON.stringify(keyPayload);
				const existing = groups.get(key) || [];
				existing.push(document);
				groups.set(key, existing);
			}

			const results: AnyRecord[] = [];

			for (const [key, items] of groups.entries()) {
				const values = JSON.parse(key);
				const row: AnyRecord = {};

				byFields.forEach((field: string, index: number) => {
					row[field] = values[index];
				});

				if (args._count) {
					row._count = items.length;
				}

				if (args._avg) {
					row._avg = {};
					for (const [field, enabled] of Object.entries(args._avg)) {
						if (!enabled) continue;
						const numbers = items
							.map((item: AnyRecord) => item[field])
							.filter((value: any) => typeof value === 'number');
						row._avg[field] = numbers.length ? numbers.reduce((sum: number, value: number) => sum + value, 0) / numbers.length : null;
					}
				}

				results.push(row);
			}

			return results;
		},
	};
}

function buildCompatClient(): AnyRecord {
	const delegates: AnyRecord = {
		$connect: async (): Promise<void> => {
			await getMongoDb();
		},
		$disconnect: async (): Promise<void> => {
			if (global.__mongoClientPromise) {
				const client = await global.__mongoClientPromise;
				await client.close();
			}
			global.__mongoDbPromise = undefined;
			global.__mongoClientPromise = undefined;
		},
	};

	for (const modelName of Object.keys(MODEL_META)) {
		delegates[modelName] = createModelDelegate(modelName);
	}

	return delegates;
}

const prisma = global.__mongoPrismaCompat ?? buildCompatClient();

if (process.env.NODE_ENV !== 'production') {
	global.__mongoPrismaCompat = prisma;
}

export default prisma;
