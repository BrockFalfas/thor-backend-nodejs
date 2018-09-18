import {AutoWired, Inject} from 'typescript-ioc';
import * as models from './models';
import * as db from '../db';
import * as user from '../user/models';
import * as transfer from './transfer/models';
import {TransferService} from './transfer/service';
import * as dwolla from '../dwolla';
import {TenantService} from '../tenant/service';
import {UserService} from '../user/service';
import {raw, transaction} from 'objection';
import {ApiServer} from '../server';
import {event} from '../dwolla';

@AutoWired
export class TransactionService extends db.ModelService<models.Transaction> {
    @Inject private dwollaClient: dwolla.Client;
    protected modelType = models.Transaction;
    public transferService: TransferService;
    protected tenantService: TenantService;
    protected userService: UserService;

    constructor(@Inject transferService: TransferService,
                @Inject tenantService: TenantService,
                @Inject userService: UserService) {
        super();
        this.transferService = transferService;
        this.userService = userService;
        this.tenantService = tenantService;
    }

    tenantContext(query) {
        return query.where(`${db.Tables.transactions}.tenantId`, this.getTenantId());
    }

    getOptions(query) {
        query.eager({[models.Relations.job]: true, [models.Relations.transfer]: true});

        return query;
    }

    getListOptions(query) {
        query.eager({[models.Relations.job]: true});

        return query;
    }

    async getForUser({page = 1, limit}: { page?: number; limit?: number },
                     {userId, startDate, endDate, status}: { userId: string; startDate?: string; endDate?: string; status?: string }) {
        limit = this.paginationLimit(limit);
        const query = this.modelType.query();
        const knex = ApiServer.db;
        query.where({userId});
        query.page(page - 1, limit);
        const eagerObject = {
            job: {$modify: ['job']},
        };
        const eagerFilters = {
            job: builder => {
                builder.select(['id', 'value', 'name', 'description']);
            },
        };
        if (startDate && endDate) {
            query.whereRaw('"transactions"."createdAt" between ? and ( ? :: timestamptz + INTERVAL \'1 day\')', [
                startDate,
                endDate,
            ]);
        }
        if (status) {
            query.where('transactions.status', status);
        }
        query
            .join('jobs', 'transactions.jobId', 'jobs.id')
            .select(['transactions.*', knex.raw('transactions.quantity * jobs.value as value')]);
        query.eager(eagerObject, eagerFilters);
        query.orderBy(`${db.Tables.transactions}.createdAt`, 'desc');
        const result = await this.tenantContext(query);
        return new db.Paginated(new db.Pagination(page, limit, result.total), result.results);
    }


    async createTransaction(transaction: models.Transaction): Promise<models.Transaction> {
        transaction.tenantId = this.getTenantId();
        transaction.status = models.Statuses.new;
        return await this.insert(transaction);
    }

    async prepareTransfer(_transaction: models.Transaction, admin: user.User): Promise<transfer.Transfer> {
        const tenant = await this.tenantService.get(_transaction.tenantId);
        const user = await this.userService.get(_transaction.userId);

        if (!user.tenantProfile.dwollaSourceUri) {
            throw new models.InvalidTransferData('Bank account not configured for recipient');
        }
        let _transfer = new transfer.Transfer();
        _transfer.adminId = admin.id;
        _transfer.status = transfer.Statuses.new;
        _transfer.destinationUri = user.tenantProfile.dwollaSourceUri;
        _transfer.sourceUri = tenant.dwollaUri;
        _transfer.value = Number(_transaction.value);
        _transaction.status = models.Statuses.processing;
        await transaction(this.transaction(), async trx => {
            _transfer = await this.transferService.createTransfer(_transfer, trx);
            // TODO: why was it changed to update rather then relate?
            // await _transfer.$relatedQuery(transfer.Relations.transaction, trx).relate(_transaction.id);
            _transaction.transferId = _transfer.id;
            await this.update(_transaction, trx);
        });
        _transaction.transfer = _transfer;

        return _transfer;
    }

    async createExternalTransfer(_transaction: models.Transaction) {
        await this.dwollaClient.authorize();
        const dwollaTransfer = dwolla.transfer.factory({});
        dwollaTransfer.setSource(_transaction.transfer.sourceUri);
        dwollaTransfer.setDestination(_transaction.transfer.destinationUri);
        dwollaTransfer.setAmount(_transaction.transfer.value);
        dwollaTransfer.setCurrency('USD');
        try {
            _transaction.transfer.externalId = await this.dwollaClient.createTransfer(dwollaTransfer);
            const _transfer = await this.dwollaClient.getTransfer(_transaction.transfer.externalId);
            await this.updateTransactionStatus(_transaction, _transfer.status);
        } catch (e) {
            await this.updateTransactionStatus(_transaction, models.Statuses.failed);
            throw e;
        }
    }

    async getStatistics({startDate, endDate}: { startDate: string; endDate: string }) {
        // TODO: I think it should be moved to stats service, also is it injection safe?
        const base = ApiServer.db
            .from('transactions')
            .where({'transactions.tenantId': this.getTenantId()})
            .whereRaw('"transactions"."createdAt" between ? and ( ? :: timestamptz + INTERVAL \'1 day\')', [
                startDate,
                endDate,
            ]);
        const totalQuery = base.count('* as total').first();
        const a = await Promise.all([totalQuery]);
        const [{total}] = a;
        // TODO: missing stats response definition
        return {approved: '0', postponed: '0', total};
    }

    async getPeriodStats(startDate: Date, endDate: Date, page?: number, limit?: number, status?: string) {
        const query = this.tenantContext(this.modelType.query());
        query.joinRelation(models.Relations.job);
        models.Transaction.periodFilter(query, startDate, endDate, status);
        query.select([
            raw(`sum(${db.Tables.transactions}.quantity * ${models.Relations.job}.value) as total`),
            raw(`count("${db.Tables.transactions}"."userId") as users`)
        ]);
        query.groupBy([`${db.Tables.transactions}.tenantId`]).first();
        const queryResult = await query;
        return queryResult || {total: '0', users: '0'};
    }

    async getDwollaByTransferExternalId(id: string) {
        // no tenat context for Dwolla
        const query = this.getOptions(this.modelType.query());
        query.rightJoinRelation(models.Relations.transfer).where(`${models.Relations.transfer}.externalId`, id);
        return await query.first();
    }

    private mapDwollaStatus(status: string) {
        switch (status) {
            case event.TYPE.transferCanceled:
                return models.Statuses.canceled;
            case event.TYPE.transferFailed:
                return models.Statuses.failed;
            case event.TYPE.transferReclaimed:
                return models.Statuses.reclaimed;
            case event.TYPE.transferCompleted:
                return models.Statuses.processed;
        }

        return status;
    }

    async updateTransactionStatus(_transaction: models.Transaction, status: string) {
        await transaction(this.transaction(), async trx => {
            status = this.mapDwollaStatus(status);
            _transaction.status = status;
            _transaction.transfer.status = status;

            await this.update(_transaction, trx);
            await this.transferService.update(_transaction.transfer, trx);
        });
    }
}
