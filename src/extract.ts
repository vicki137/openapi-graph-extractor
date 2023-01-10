import type {OpenAPIV2, OpenAPIV3} from 'npm:openapi-types@12.1.0';

import {RequestConfig, ServiceAugmentation, ServiceConfigOpenApiV2} from './exporter.ts';

// @ts-expect-error untyped
import graphy from 'npm:graphy@4.3.5';
import {Dict, fodemtv, JsonObject, ode} from './belt.ts';
import { deref, Dereference, LinkedDataWrapper } from './json-schema.ts';
import { LinkedDataSchemaDef, Translation } from './translation.ts';



class Extraction {
	static async create(gc_service: ServiceConfigOpenApiV2, g_augmentation: ServiceAugmentation): Promise<Extraction> {
		const k_extraction = new Extraction(gc_service, g_augmentation);

		await k_extraction._init();

		return k_extraction;
	}

	protected _ds_writer: {
		write(g_write: {type:string; value:object}): void;
		end(): void;
	};

	protected _g_document: OpenAPIV2.Document;
	protected _h_paths: NonNullable<ServiceConfigOpenApiV2['paths']>;
	protected _as_warnings = new Set<string>();
	protected _p_root: string;
	protected _as_resources = new Set<string>();
	protected _as_discovered = new Set<string>();

	protected _f_fetch: (p_url: string, gc_fetch: RequestInit) => Promise<Response>;

	private constructor(protected _gc_service: ServiceConfigOpenApiV2, protected _g_augmentation: ServiceAugmentation) {
		const g_document = this._g_document = _gc_service.openApiDocument;		

		// destructure document properties
		let {
			host: p_host,
			basePath: sr_base,
		} = g_document;

		// destructure service config
		const {
			paths: h_paths,
			allPaths: g_all_paths,
			pagination: g_pagination,	
			overrides: g_overrides,
		} = _gc_service;

		// config overrides
		if(g_overrides?.host) p_host = g_document.host = g_overrides.host;
		if(g_overrides?.basePath) sr_base = g_document.basePath = g_overrides.basePath;

		// assert host and base properties are defined
		if(!p_host || !sr_base) {
			throw new Error(`'host' and 'basePath' properties are required to be defined in the document or overriden by the config`);
		}

		// prep fields
		this._h_paths = h_paths || {};
		this._f_fetch = _g_augmentation.fetch || fetch;

		// construct root URL
		const _p_root = this._p_root = `${p_host}${sr_base}`;
		
		// prep rdf content writer
		const ds_writer = this._ds_writer = graphy.content.ttl.write({
			prefixes: {
				rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
				rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
				xsd: 'http://www.w3.org/2001/XMLSchema#',
				oajs: 'https://openmbee.org/openapi-json-schema#',
				'': `${_p_root}/#`,
			},
		});

		// pipe to stdout
		ds_writer.on('data', (atu8_data: Uint8Array) => {
			Deno.stdout.write(atu8_data);
		});
	}

	async _init() {

	}

	// only log each distinct warning once
	_warn(s_warn: string) {
		const {_as_warnings} = this;

		if(!_as_warnings.has(s_warn)) {
			console.warn(s_warn);
			_as_warnings.add(s_warn);
		}
	}

	/**
	 * Iterates through all the GET-able endpoints and converts the data to RDF
	 */
	async sweep() {
		const {_g_document} = this;

		for(const [sr_path, g_path] of ode(_g_document.paths)) {
			this._obtain(sr_path, {}, g_path);
		}
	}

	async _obtain(sr_path: string, h_args_query: Dict<string|number>={}, g_path=this._g_document.paths[sr_path]) {
		const {_g_document, _h_paths, _gc_service} = this;

		// check for path config
		const gc_path = _h_paths[sr_path];

		// skip this path
		if(gc_path?.skip) return;

		// only interested in the readonly endpoints
		const g_get = g_path['get'] as Dereference.Deeply<typeof g_path['get']>;
		if(!g_get) return;

		// // prep local args
		// const h_args_query: Dict<string|number> = {};

		// prepare the specific path config
		const gc_req_path = gc_path?.prepare?.(g_get);
		if(gc_req_path) {
			Object.assign(h_args_query, gc_req_path.queryArgs || {})
		}

		// prepare the general path config
		const gc_req_all = _gc_service.allPaths?.prepare?.(g_get);
		if(gc_req_all) {
			Object.assign(h_args_query, gc_req_all.queryArgs || {})
		}

		// prep list of required params
		const a_required_params = [];

		// each parameter
		for(const g_param of g_get.parameters || []) {
			// query param
			if('query' === g_param.in) {
				// argument already set for parameter
				if(g_param.name in h_args_query) continue;

				// param is required
				if(g_param.required) {
					a_required_params.push(g_param);
				}
			}
		}

		// endpoint requires params that are not set
		if(a_required_params.length) {
			this._warn(`Skipping ${sr_path} since it requires parameters for: ${a_required_params.map(g => g.name).join(', ')}`);
			return;
		}

		const g_ok = deref(g_get.responses?.['200'] || {}, _g_document as unknown as JsonObject);
		if(!g_ok?.schema) {
			this._warn(`Skipping ${sr_path} since it does not have a defined response schema`);
			return;
		}

		await this._submit(g_get, sr_path, {
			queryArgs: h_args_query,
		});
	}

	async _submit(g_operation: Dereference.Deeply<NonNullable<OpenAPIV2.OperationObject>>, sr_path: string, gc_req: RequestConfig) {
		const {_p_root, _gc_service, _h_paths, _as_resources, _as_discovered} = this;

		const gc_path = _h_paths[sr_path];

		const g_pagination = _gc_service.pagination;

		const b_paginating = g_pagination?.requiresPagination?.(g_operation);

		for(let i_offset=0;;) {
			const h_args_query = {...gc_req.queryArgs};

			// is paginting
			if(b_paginating) {
				// invoke next page callback
				const gc_args = g_pagination?.nextPage?.(i_offset, g_operation) || {};

				// apply request config
				Object.assign(h_args_query, fodemtv(gc_args?.queryArgs || {}, w => ''+w));
			}

			// stringify query args
			const sx_args = (new URLSearchParams(fodemtv(h_args_query, w => ''+w))).toString();
			
			// execute request
			const d_res = await this._f_fetch(`${_p_root}?${sx_args || ''}`, {
				method: 'GET',
				headers: {
					'accept': (g_operation.produces || ['application/json']).join(','),
				},
			});

			// parse response body as JSON
			const g_body = await d_res.json() as LinkedDataWrapper;

			const g_response_schema = g_operation.responses?.['200']?.schema;
			if(!g_response_schema) {
				throw new Error(`Response schema missing from operation at ${sr_path}`);
			}

			// create translation instance
			const k_translation = new Translation(_p_root, sr_path, g_response_schema as LinkedDataSchemaDef, g_body, this._ds_writer, _as_resources);

			// run translation
			k_translation.run();

			// merge discovered with local field
			for(const p_discovered of k_translation.discovered) {
				_as_discovered.add(p_discovered);
			}

			if(b_paginating) {
				const nl_results = g_body.data.length as number;

				if(nl_results < g_pagination!.limit) break;

				i_offset += nl_results;
			}
			else {
				break;
			}
		}
	}

	crawl() {
		const {_g_document, _gc_service, _as_resources, _as_discovered} = this;

		// check all discovered resources
		for(const sr_discovered of [..._as_discovered]) {
			// remove resource from discovered list
			_as_discovered.delete(sr_discovered);
			
			// skip resources that were already obtained
			if(_as_resources.has(sr_discovered)) {
				continue;
			}

			// match resource to path
			const a_parts_discovered = sr_discovered.split('/');
			const nl_parts = a_parts_discovered.length;

			let sr_path_matched!: string;
			let g_path_matched!: OpenAPIV2.PathItemObject;
			let h_args_query: Dict = {};

			PATHS:
			for(const [sr_path, g_path] of ode(_g_document.paths)) {
				// slight optimization to find common prefix
				if(!sr_discovered.startsWith(sr_path.replace(/\{.*$/, ''))) continue;

				const a_parts_schema = sr_path.split('/');

				// part length mismatch; not a candidate
				if(nl_parts !== a_parts_schema.length) continue;

				// clear query args
				h_args_query = {};

				// each path part
				for(let i_part=0; i_part<nl_parts; i_part++) {
					const s_part_schema = a_parts_schema[i_part];
					const s_part_discovered = a_parts_discovered[i_part];

					// parameteric path part
					const m_param = /^\{(.+)\}$/.exec(s_part_schema);
					if(m_param) {
						h_args_query[m_param[1]] = s_part_discovered;
						continue;
					}

					// path part is different
					if(s_part_discovered !== s_part_schema) continue PATHS;
				}

				// found match
				sr_path_matched = sr_path;
				g_path_matched = g_path;
				break PATHS;
			}

			// no match found
			if(!g_path_matched) {
				this._warn(`Failed to match discovered resource to a path in the document schema: ${sr_discovered}`);
				continue;
			}

			// fetch resource
			this._obtain(sr_path_matched, h_args_query, g_path_matched);
		}

		// items remain; repeat
		if(_as_discovered.size) {
			this.crawl();
		}
	}
}

export async function extract(gc_service: ServiceConfigOpenApiV2, g_augmentation?: ServiceAugmentation | undefined) {
	const g_document = gc_service.openApiDocument;

	// config specifies version; assert version matches document
	if('string' === typeof gc_service.openApiVersion) {
		if('2.0' === gc_service.openApiVersion) {
			if('2.0' !== g_document.swagger) {
				throw new Error(`The document OpenAPI (swagger) version does not match the expected '2.0' version identifier. This can occur if the document has upgraded to a more recent specification, but you will need to ensure your config is still compatible.`);
			}
		}
		else {
			throw new Error(`Unable to verify document version`);
		}
	}

	if(!['2.0'].includes(g_document.swagger)) {
		throw new Error(`OpenApi version ${gc_service.openApiVersion} not yet implemented`);
	}

	// create extraction instance
	const k_extraction = await Extraction.create(gc_service, g_augmentation || {});

	// start with an initial sweep
	k_extraction.sweep();

	// crawl until all links are traversed
	k_extraction.crawl();
}
