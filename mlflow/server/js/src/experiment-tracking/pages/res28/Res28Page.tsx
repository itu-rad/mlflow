import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { Button, Header, Spacer, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';
import { withErrorBoundary } from '../../../common/utils/withErrorBoundary';
import ErrorUtils from '../../../common/utils/ErrorUtils';

const Res28Page = () => {
  const { theme } = useDesignSystemTheme();

  const handleOpenInNewTab = () => {
    window.open('https://res28.itu.dk', '_blank');
  };

  return (
    <ScrollablePageWrapper css={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <Spacer shrinks={false} />
      <Header
        title={<FormattedMessage defaultMessage="radT Res28" description="Header title for the RES28 page" />}
        buttons={
          <Button componentId="mlflow.res28.openInNewTab" type="primary" onClick={handleOpenInNewTab}>
            <FormattedMessage
              defaultMessage="Open in new tab"
              description="Label for button to open Res28 in a new browser tab"
            />
          </Button>
        }
      />
      <Spacer shrinks={false} />
      <div css={{ 
        flex: 1, 
        display: 'flex', 
        flexDirection: 'column', 
        overflow: 'hidden',
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.general.borderRadiusBase,
      }}>
        <iframe 
          src="https://res28.itu.dk"
          title="radT Res28"
          css={{
            border: 'none',
            width: '100%',
            height: '100%',
            flexGrow: 1,
          }}
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        />
      </div>
    </ScrollablePageWrapper>
  );
};

export default withErrorBoundary(ErrorUtils.mlflowServices.EXPERIMENTS, Res28Page);
