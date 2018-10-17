import * as mapper from '../mapper';
import * as profile from '../profile/models';
import {Mapper} from '../mapper';
import Joi = require('joi');

export class ContractorBaseModel extends Mapper {
}

export class ContractorRequest extends ContractorBaseModel {
    password: string = mapper.FIELD_STR;
    profile: profile.ProfileRequest = new profile.ProfileRequest();
    tenant: string = mapper.FIELD_STR;
    invitationToken: string = mapper.FIELD_STR;
}

export class ContractorResponse extends ContractorBaseModel {
    id: string = mapper.FIELD_STR;
    createdAt: Date = mapper.FIELD_DATE;
    updatedAt: Date = mapper.FIELD_DATE;
    lastActivity: Date = mapper.FIELD_DATE;
    tenantProfile: profile.ProfileResponse = new profile.ProfileResponse();
    token: string = null;
}

mapper.registerRelation(ContractorResponse, 'tenantProfile', new mapper.Relation(profile.ProfileResponse));

export const contractorRequestSchema = Joi.object().keys({
    profile: profile.profileRequestSchema.required(),
    tenant: Joi.string().required(),
    invitationToken: Joi.string().required(),
});



export interface PasswordRequest {
    oldPassword: string;
    newPassword: string;
    confirmPassword: string;
}

export const passwordRequestSchema = Joi.object().keys({
    oldPassword: Joi.string().required(),
    newPassword: Joi.string().required(),
    confirmPassword: Joi.string().required(),
});
