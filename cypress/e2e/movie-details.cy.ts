describe('Movie Details', () => {
  it('loads a movie page', () => {
    cy.login(Cypress.env('ADMIN_EMAIL'), Cypress.env('ADMIN_PASSWORD'));
    // Try to load minions: rise of gru
    cy.visit('/movie/438148');

    cy.get('[data-testid=media-title]').should(
      'contain',
      'Minions: The Rise of Gru (2022)'
    );
  });
});
