import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { google } from 'googleapis';
import { exportProjectTerraform } from '../src/export.js';

afterEach(() => mock.restoreAll());

function stubApis() {
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: {
      get: async () => ({
        data: {
          projectId: 'seed-proj',
          displayName: 'Seed Proj',
          parent: 'organizations/123456789012',
          labels: { 'seeded-by': 'gcp-seeder', 'seeded-at': '2026-07-01' },
        },
      }),
    },
  }) as never);
  mock.method(google, 'serviceusage', () => ({
    services: {
      list: async () => ({
        data: { services: [{ config: { name: 'run.googleapis.com' } }, { config: { name: 'iam.googleapis.com' } }] },
      }),
    },
  }) as never);
  mock.method(google, 'iam', () => ({
    projects: {
      serviceAccounts: {
        list: async () => ({
          data: {
            accounts: [
              { email: 'ci@seed-proj.iam.gserviceaccount.com', displayName: 'CI' },
              { email: '999-compute@developer.gserviceaccount.com', displayName: 'default compute' }, // must be filtered out
            ],
          },
        }),
      },
      locations: {
        workloadIdentityPools: {
          list: async () => ({ data: { workloadIdentityPools: [{ name: 'projects/9/locations/global/workloadIdentityPools/gh-pool', displayName: 'GitHub Actions' }] } }),
          providers: {
            list: async () => ({
              data: {
                workloadIdentityPoolProviders: [
                  { name: 'projects/9/locations/global/workloadIdentityPools/gh-pool/providers/gh-acme-repo', oidc: { issuerUri: 'https://token.actions.githubusercontent.com' }, attributeCondition: "assertion.repository == 'acme/repo'" },
                ],
              },
            }),
          },
        },
      },
    },
  }) as never);
}

test('renders Terraform for project, APIs, user SAs, and WIF', async () => {
  stubApis();
  const { hcl, counts } = await exportProjectTerraform({ projectId: 'seed-proj', auth: {} as never });

  // project block with parent + labels
  assert.match(hcl, /resource "google_project" "seed_proj"/);
  assert.match(hcl, /project_id = "seed-proj"/);
  assert.match(hcl, /org_id = "123456789012"/);
  assert.match(hcl, /"seeded-by" = "gcp-seeder"/);

  // enabled APIs
  assert.match(hcl, /resource "google_project_service".*\n\s*project = google_project\.seed_proj\.project_id\n\s*service = "run\.googleapis\.com"/);
  assert.match(hcl, /service = "iam\.googleapis\.com"/);

  // user SA present, default compute SA filtered out
  assert.match(hcl, /resource "google_service_account" "ci"/);
  assert.match(hcl, /account_id   = "ci"/);
  assert.doesNotMatch(hcl, /compute@developer/);

  // WIF pool + provider with the repo-locked condition
  assert.match(hcl, /resource "google_iam_workload_identity_pool" "pool_gh_pool"/);
  assert.match(hcl, /workload_identity_pool_id = "gh-pool"/);
  assert.match(hcl, /resource "google_iam_workload_identity_pool_provider"/);
  assert.match(hcl, /attribute_condition = "assertion\.repository == 'acme\/repo'"/);
  assert.match(hcl, /issuer_uri = "https:\/\/token\.actions\.githubusercontent\.com"/);

  assert.deepEqual(counts, { services: 2, serviceAccounts: 1, wifPools: 1 });
});

test('export tolerates a project with no WIF pools (API off)', async () => {
  mock.method(google, 'cloudresourcemanager', () => ({
    projects: { get: async () => ({ data: { projectId: 'p', displayName: 'P' } }) },
  }) as never);
  mock.method(google, 'serviceusage', () => ({ services: { list: async () => ({ data: { services: [] } }) } }) as never);
  mock.method(google, 'iam', () => ({
    projects: { serviceAccounts: { list: async () => ({ data: { accounts: [] } }) } }, // no `locations` → listWifPools throws → caught
  }) as never);

  const { hcl, counts } = await exportProjectTerraform({ projectId: 'p', auth: {} as never });
  assert.match(hcl, /resource "google_project" "p"/);
  assert.deepEqual(counts, { services: 0, serviceAccounts: 0, wifPools: 0 });
});
