import {PaginatedResponse, mapper} from '../api';
import {Mapper} from '../mapper';
import * as db from '../db';
import {Relation} from 'objection'; // for ManyToManyRelation compilation
import Joi = require('joi');
import * as tenant from '../tenant/models';
import * as user from '../user/models';
import * as job from '../job/models';

export const enum Relations {
    user = 'user',
    tenant = 'tenant',
    admin = 'admin',
    job = 'job',
}

export const enum Statuses {
    new = 'new',
}

export class Transaction extends db.Model {
    static tableName = db.Tables.transactions;
    userId?: string;
    adminId?: string;
    tenantId?: string;
    jobId?: string;
    quantity?: number;
    status?: string;
    user?: user.User;
    job?: job.Job;

    static get relationMappings() {
        return {
            [Relations.user]: {
                relation: db.Model.BelongsToOneRelation,
                modelClass: user.User,
                join: {
                    from: `${db.Tables.transactions}.userId`,
                    to: `${db.Tables.users}.id`
                }
            },
            [Relations.tenant]: {
                relation: db.Model.BelongsToOneRelation,
                modelClass: tenant.Tenant,
                join: {
                    from: `${db.Tables.transactions}.tenantId`,
                    to: `${db.Tables.tenants}.id`
                }
            },
            [Relations.admin]: {
                relation: db.Model.BelongsToOneRelation,
                modelClass: user.User,
                join: {
                    from: `${db.Tables.transactions}.adminId`,
                    to: `${db.Tables.users}.id`
                }
            },
            [Relations.job]: {
                relation: db.Model.BelongsToOneRelation,
                modelClass: job.Job,
                join: {
                    from: `${db.Tables.transactions}.jobId`,
                    to: `${db.Tables.jobs}.id`
                }
            },
        };
    }
}

export class TransactionBaseInfo extends Mapper {
    quantity: number = mapper.FIELD_NUM;
    userId: string = mapper.FIELD_STR;
    jobId: string = mapper.FIELD_STR;
}

export class TransactionResponse extends TransactionBaseInfo {
    id: string = mapper.FIELD_STR;
    status: string = mapper.FIELD_STR;
    createdAt: Date = mapper.FIELD_DATE;
    updatedAt: Date = mapper.FIELD_DATE;
    job: job.JobResponse = new job.JobResponse();
}

mapper.registerRelation(TransactionResponse, Relations.job, new mapper.Relation(job.JobResponse));

export class TransactionRequest extends TransactionBaseInfo {}

export interface PaginatedTransactionReponse extends PaginatedResponse {
    items: Array<TransactionResponse>;
}

export const transactionRequestSchema = Joi.object().keys({
    userId: Joi.string().required(),
    jobId: Joi.string().required(),
    quantity: Joi.number().required(),
});