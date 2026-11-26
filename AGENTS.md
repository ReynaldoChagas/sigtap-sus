# Instruções do Agente

## Comunicação antes de executar tarefas

Sempre que o usuário solicitar uma nova funcionalidade ou task, antes de iniciar a execução (ou ao iniciar), explique de forma resumida:

1. **Plano**: quais etapas serão realizadas para atender ao pedido.
2. **Ferramentas**: quais ferramentas serão utilizadas (ex.: leitura/edição de arquivos, comandos no terminal, busca na web, subagentes, etc.).

## Fluxo de Git e Pull Request

Sempre que o usuário solicitar uma nova funcionalidade ou task:

1. Crie uma nova branch de feature no Git (ex.: `feature/<nome-da-task>`) a partir da branch principal atualizada.
2. Implemente a alteração e execute os testes/validações aplicáveis.
3. Faça o commit e push da branch, abra um Pull Request no GitHub e realize o merge caso passe nos testes.
