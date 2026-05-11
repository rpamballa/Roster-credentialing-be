import { createSchema } from "graphql-yoga";
import type { GqlContext } from "./context.js";
import { facilityResolvers } from "./resolvers/facility.js";

export const cockpitSchema = createSchema<GqlContext>({
  typeDefs: /* GraphQL */ `
    scalar JSON

    type Query {
      health: String!
      facilityProfiles(status: String): [FacilityProfile!]!
      facilityProfile(id: ID!): FacilityProfileDetail
    }

    type Mutation {
      facilityProfileCorrect(input: FacilityProfileCorrectInput!): FacilityProfile!
      facilityProfileApprove(id: ID!): FacilityProfile!
    }

    type FacilityProfile {
      id: ID!
      facilityId: ID!
      facilityName: String!
      version: Int!
      status: String!
      approvedAt: String
      approvedBy: ID
      createdAt: String!
      updatedAt: String!
    }

    type FacilityProfileDetail {
      profile: FacilityProfile!
      requirements: JSON!
      sourcePacketUri: String
    }

    input FacilityProfileCorrectInput {
      id: ID!
      fieldPath: String!
      after: JSON!
    }
  `,
  resolvers: {
    Query: {
      health: () => "ok",
      facilityProfiles: facilityResolvers.list,
      facilityProfile: facilityResolvers.byId,
    },
    Mutation: {
      facilityProfileCorrect: facilityResolvers.correct,
      facilityProfileApprove: facilityResolvers.approve,
    },
  },
});
