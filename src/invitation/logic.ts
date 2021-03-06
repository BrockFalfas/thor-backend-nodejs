import * as parserAsync from 'csv-parse';
import Joi = require('joi');
import * as _ from 'lodash';
import * as objection from 'objection';
import {AutoWired, Inject} from 'typescript-ioc';
import {Errors} from 'typescript-rest';
import {Config} from '../config';
import {Logger} from '../logger';
import {Logic} from '../logic';
import {MailerService} from '../mailer';
import * as models from './models';
import {Invitation} from './models';
import {Profile} from '../profile/models';
import {InvitationService} from './service';
import {TenantService} from '../tenant/service';
import {ProfileService} from '../profile/service';

@AutoWired
export class BatchInvitationsLogic extends Logic {
    @Inject mailerService: MailerService;
    @Inject invitations: InvitationService;
    @Inject tenants: TenantService;
    @Inject profiles: ProfileService;
    @Inject config: Config;
    @Inject logger: Logger;
    private maxRows = this.config.get('invitations.csv.rows');

    async execute(buffer: Buffer): Promise<Array<Invitation>> {
        const parser = new parserAsync.Parser({
            skip_empty_lines: true,
            skip_lines_with_empty_values: true,
            trim: true,
            delimiter: ';',
            from: 2,
            columns: ['email'],
            relax_column_count: true,
            to: this.maxRows,
        });

        parser.write(buffer);
        parser.end();

        if (parser.lines > this.maxRows) {
            throw new Errors.ConflictError(`CSV file has to many rows, max allowed: ${this.maxRows}`);
        }

        const invitations = await new Promise<Array<Invitation>>((resolve, reject) => {
            const invitations: Array<Invitation> = [];
            parser.on('readable', function() {
                let record = null;
                while ((record = parser.read())) {
                    if (BatchInvitationsLogic.validateEmail(record.email))
                        invitations.push(
                            Invitation.factory({
                                email: record.email,
                            }),
                        );
                }
            });
            parser.on('error', function(err) {
                console.error(err.message);
                reject(err.message);
            });
            parser.on('end', function() {
                resolve(invitations);
            });
        });

        const emails = invitations
            .map(invitation => {
                return invitation.email;
            })
            .filter(email => {
                return BatchInvitationsLogic.validateEmail(email);
            });

        if (_.isEmpty(emails)) {
            throw new Errors.NotAcceptableError('No emails to import');
        }

        await this.checkEmailsDuplicates(emails);
        await this.checkExistingUsers(emails);

        const tenant = await this.tenants.get(this.context.getTenantId());
        for (let invitation of invitations) {
            invitation.status = models.Status.sent;
            invitation.tenantId = tenant.id;
            invitation = await this.invitations.insert(invitation);

            try {
                this.mailerService.sendInvitation(invitation.email, {
                    link: `${this.config.get('application.frontUri')}/register/${invitation.id}`,
                    companyName: tenant.businessName,
                });
            } catch (error) {
                this.logger.error(error);
            }
        }

        return invitations;
    }

    private async checkEmailsDuplicates(emails: Array<string>) {
        const result = await this.invitations.getByEmails(emails);

        if (!_.isEmpty(result)) {
            return this.parseError(
                'Emails already invited',
                result.map(inv => {
                    return inv.email;
                }),
            );
        }
    }

    private async checkExistingUsers(emails: Array<string>) {
        const profiles = await this.profiles.getByEmails(emails);

        if (!_.isEmpty(profiles)) {
            return this.parseError(
                'Emails already registered',
                profiles.map(prof => {
                    return prof.email;
                }),
            );
        }
    }

    private async checkRegisteredUsersDuplicates(externalIds: Array<string>) {
        const profiles = await this.profiles.getByExternalIds(externalIds);

        if (!_.isEmpty(profiles)) {
            return this.parseError(
                'ExternalIds already registered',
                profiles.map(prof => {
                    return prof.email;
                }),
            );
        }
    }

    private parseError(status: string, items: Array<string>) {
        const e: any = new Errors.ConflictError();
        e.message = {
            status: status,
            items: items,
        };

        throw e;
    }

    private static validateEmail(email: string): boolean {
        if (
            Joi.validate(
                email,
                Joi.string()
                    .required()
                    .email(),
            ).error
        ) {
            return false;
        }
        return true;
    }
}

@AutoWired
export class CreateAdminInvitationLogic extends Logic {
    @Inject private mailerService: MailerService;
    @Inject private invitationService: InvitationService;
    @Inject private tenantService: TenantService;
    @Inject private config: Config;
    @Inject private logger: Logger;

    async execute(profile: Profile, trx?: objection.Transaction) {
        const tenantId = await this.context.getTenantId();
        let invitation = models.Invitation.factory({
            ...profile,
            type: models.Types.admin,
            status: models.Status.pending,
        });
        invitation = await this.invitationService.insert(invitation, trx);

        try {
            const tenant = await this.tenantService.get(tenantId);
            await this.mailerService.sendAdminConfirmAccount(invitation.email, {
                link: `${this.config.get('application.frontUri')}/register/${invitation.id}`,
                companyName: tenant.businessName,
            });
        } catch (e) {
            this.logger.error(e);
        }
        return invitation;
    }
}

@AutoWired
export class CreateContractorInvitationLogic extends Logic {
    @Inject private mailer: MailerService;
    @Inject private invitationService: InvitationService;
    @Inject private tenantService: TenantService;
    @Inject private config: Config;
    @Inject private logger: Logger;

    async execute(profile: Profile, trx?: objection.Transaction) {
        const tenantId = await this.context.getTenantId();
        let invitation = models.Invitation.factory({
            ...profile,
            type: models.Types.contractor,
            status: models.Status.pending,
        });
        invitation = await this.invitationService.insert(invitation, trx);

        try {
            const tenant = await this.tenantService.get(tenantId);
            await this.mailer.sendInvitation(invitation.email, {
                link: `${this.config.get('application.frontUri')}/register/${invitation.id}`,
                companyName: tenant.businessName,
            });
        } catch (e) {
            this.logger.error(e);
        }
        return invitation;
    }
}

@AutoWired
export class GetInvitationLogic extends Logic {
    @Inject private invitationService: InvitationService;

    async execute(id: string) {
        const invitation = await this.invitationService.getForAllTenants(id);
        if (!invitation) {
            throw new Errors.NotFoundError();
        }

        if (!invitation.isPending()) {
            throw new Errors.NotAcceptableError('Invitation already used');
        }
        return invitation;
    }
}

@AutoWired
export class GetInvitationsLogic extends Logic {
    @Inject private invitationService: InvitationService;

    async execute(page?: number, limit?: number, status?: string, type?: string) {
        const filter = builder => {
            models.Invitation.filter(builder, status, type);
        };

        const options = builder => {
            builder.orderBy(`${models.Invitation.tableName}.createdAt`, 'desc');
        };

        return await this.invitationService.listPaginated(page, limit, filter, options);
    }
}

@AutoWired
export class ResendInvitationLogic extends Logic {
    @Inject private invitationService: InvitationService;
    @Inject private mailerService: MailerService;
    @Inject private tenantService: TenantService;
    @Inject private logger: Logger;
    @Inject private config: Config;

    async execute(id?: string, userId?: string) {
        let invitation;
        if (id) {
            invitation = await this.invitationService.get(id);
        } else if (userId) {
            invitation = await this.invitationService.getByUserId(userId);
        } else {
            throw new Errors.BadRequestError('missing id');
        }
        if (!invitation) {
            throw new Errors.NotFoundError('Invitation not found');
        }

        if (!invitation.isPending()) {
            throw new Errors.ConflictError('Invitation already used');
        }

        const tenant = await this.tenantService.get(this.context.getTenantId());
        if (!tenant) {
            throw new Errors.NotFoundError('Tenant not found');
        }

        try {
            if (invitation.type === models.Types.admin) {
                await this.mailerService.sendAdminConfirmAccount(invitation.email, {
                    link: `${this.config.get('application.frontUri')}/register/${invitation.id}`,
                    companyName: tenant.businessName,
                });
            } else {
                await this.mailerService.sendInvitation(invitation.email, {
                    link: `${this.config.get('application.frontUri')}/register/${invitation.id}`,
                    companyName: tenant.businessName,
                });
            }
        } catch (e) {
            this.logger.error(e);
        }
    }
}

@AutoWired
export class DeleteUserInvitationLogic extends Logic {
    @Inject private invitationService: InvitationService;

    async execute(userId: string) {
        const invitation = await this.invitationService.getByUserId(userId);
        if (!invitation) {
            throw new Errors.NotFoundError();
        }

        if (!invitation.isPending()) {
            throw new Errors.ConflictError('Invitation already used');
        }

        try {
            await this.invitationService.delete(invitation);
        } catch (e) {
            throw new Errors.InternalServerError(e);
        }
    }
}

@AutoWired
export class DeleteInvitationLogic extends Logic {
    @Inject private invitationService: InvitationService;

    async execute(id: string) {
        const invitation = await this.invitationService.get(id);
        if (!invitation) {
            throw new Errors.NotFoundError();
        }

        if (!invitation.isPending()) {
            throw new Errors.ConflictError('Invitation already used');
        }

        try {
            await this.invitationService.delete(invitation);
        } catch (e) {
            throw new Errors.InternalServerError(e);
        }
    }
}

@AutoWired
export class UseInvitationLogic extends Logic {
    @Inject private invitationService: InvitationService;

    async execute(id: string, trx?: objection.Transaction) {
        trx = this.invitationService.transaction(trx);

        return await objection.transaction(trx, async _trx => {
            const invitation = await this.invitationService.getForAllTenants(id, _trx);
            if (!invitation) {
                throw new Errors.NotFoundError();
            }

            if (!invitation.isPending()) {
                throw new Errors.NotAcceptableError('Invitation already used');
            }

            invitation.status = models.Status.used;
            return await this.invitationService.update(invitation, trx);
        });
    }
}
