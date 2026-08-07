import { jest, describe, beforeAll, it, expect } from '@jest/globals';
import { rest } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import { DesignSystemProvider } from '@databricks/design-system';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { setupServer } from '../../../common/utils/setup-msw';
import { setupTestRouter, testRoute, TestRouter } from '../../../common/utils/RoutingTestUtils';
import RadtPage from './RadtPage';

const RADT_CONFIG_ENDPOINT = '/ajax-api/2.0/mlflow/radt-config';

describe('RadtPage', () => {
  const server = setupServer();
  const { history } = setupTestRouter();

  beforeAll(() => {
    process.env['MLFLOW_USE_ABSOLUTE_AJAX_URLS'] = 'true';
  });

  const respondWithUrl = (radtUrl: string | null) => {
    server.use(rest.get(RADT_CONFIG_ENDPOINT, (req, res, ctx) => res(ctx.json({ radt_url: radtUrl }))));
  };

  const renderPage = (initialEntry = '/radt') => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <TestRouter routes={[testRoute(<RadtPage />, '/radt')]} history={history} initialEntries={[initialEntry]} />,
      {
        wrapper: ({ children }) => (
          <DesignSystemProvider>
            <QueryClientProvider client={queryClient}>
              <IntlProvider locale="en">{children}</IntlProvider>
            </QueryClientProvider>
          </DesignSystemProvider>
        ),
      },
    );
  };

  it('embeds the radT URL served by the backend', async () => {
    respondWithUrl('http://radt.example.com:8501');
    renderPage();

    await waitFor(() => {
      expect(screen.getByTitle('radT Analyze')).toHaveAttribute('src', 'http://radt.example.com:8501');
    });
  });

  it('forwards the current query string to the embedded radT instance', async () => {
    respondWithUrl('http://radt.example.com:8501');
    renderPage('/radt?runs=["abc","def"]');

    await waitFor(() => {
      expect(screen.getByTitle('radT Analyze')).toHaveAttribute(
        'src',
        'http://radt.example.com:8501?runs=["abc","def"]',
      );
    });
  });

  it('explains how to configure radT when the server reports no URL', async () => {
    respondWithUrl(null);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('radT is not configured')).toBeInTheDocument();
    });
    expect(screen.getByText(/MLFLOW_RADT_URL/)).toBeInTheDocument();
    expect(screen.queryByTitle('radT Analyze')).not.toBeInTheDocument();
  });
});
